import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BKCRACK = path.resolve(__dirname, '..', 'bkcrack', 'bkcrack.exe')
const WORK = path.join(os.tmpdir(), 'opencode', 'zipcrack')

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function decodeName(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

function parseEntries(zipPath) {
  const fd = fs.openSync(zipPath, 'r')
  try {
    const stat = fs.fstatSync(fd)
    const tailLen = Math.min(stat.size, 65557)
    const buf = Buffer.alloc(tailLen)
    fs.readSync(fd, buf, 0, tailLen, stat.size - tailLen)
    let rel = -1
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { rel = i; break }
    }
    if (rel < 0) throw new Error('EOCD 未找到')
    const eocd = buf.subarray(rel)
    const count = eocd.readUInt16LE(10)
    const cdSize = eocd.readUInt32LE(12)
    const cdStart = eocd.readUInt32LE(16)
    const cd = Buffer.alloc(cdSize)
    fs.readSync(fd, cd, 0, cdSize, cdStart)
    const entries = []
    let pos = 0
    for (let i = 0; i < count; i++) {
      if (cd.readUInt32LE(pos) !== 0x02014b50) throw new Error('中央目录签名错误')
      const gpFlag = cd.readUInt16LE(pos + 8)
      const method = cd.readUInt16LE(pos + 10)
      const crc = cd.readUInt32LE(pos + 16)
      const csize = cd.readUInt32LE(pos + 20)
      const usize = cd.readUInt32LE(pos + 24)
      const fnlen = cd.readUInt16LE(pos + 28)
      const eflen = cd.readUInt16LE(pos + 30)
      const cmlen = cd.readUInt16LE(pos + 32)
      const extAttr = cd.readUInt32LE(pos + 38)
      const lho = cd.readUInt32LE(pos + 42)
      const name = cd.subarray(pos + 46, pos + 46 + fnlen)
      const isDir = (extAttr & 0x10) !== 0 || (name.byteLength > 0 && name[name.byteLength - 1] === 0x2f)
      entries.push({
        index: i,
        name,
        gpFlag,
        method,
        crc,
        csize,
        usize,
        lho,
        isDir,
        encrypted: (gpFlag & 1) !== 0,
        aes: (gpFlag & 0x40) !== 0,
        descriptor: (gpFlag & 8) !== 0,
        utf8Name: (gpFlag & 0x800) !== 0,
      })
      pos += 46 + fnlen + eflen + cmlen
    }
    return { entries, cdStart, cdSize, count }
  } finally {
    fs.closeSync(fd)
  }
}

function asciiCopy(zipPath) {
  fs.mkdirSync(WORK, { recursive: true })
  const dst = path.join(WORK, 'zip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.zip')
  fs.copyFileSync(zipPath, dst)
  return dst
}

function knownPlaintextHints(entries) {
  const enc = entries.filter((e) => e.encrypted && !e.isDir)
  return enc.map((e) => {
    const n = decodeName(e.name).toLowerCase()
    let kind = 'unknown'
    let known = []
    if (n.endsWith('.png')) {
      kind = 'png'
      known = [{ offset: 5, hex: '89504E470D0A1A0A0000000D49484452', note: 'PNG签名+IHDR长度+IHDR，存储块头5字节后偏移5（Info-ZIP/zlib 常用）' }]
    } else if (n.endsWith('.mp4') || n.endsWith('.mov') || n.endsWith('.m4v') || n.endsWith('.mp3') || n.endsWith('.flac')) {
      kind = 'media'
      known = [{ offset: 5, hex: '0000002066747970', note: 'MP4/MOV ftyp box 前8字节（存储块偏移5），不同文件brand不同，需确认' }]
    }
    return { index: e.index, name: decodeName(e.name), kind, known }
  })
}

export function analyze(zipPath) {
  const { entries, count, cdStart, cdSize } = parseEntries(zipPath)
  const list = entries.map((e) => ({
    index: e.index,
    name: decodeName(e.name),
    encrypted: e.encrypted,
    aes: e.aes,
    method: e.method,
    descriptor: e.descriptor,
    dir: e.isDir,
    csize: e.csize,
    usize: e.usize,
    crc: '0x' + e.crc.toString(16),
  }))
  return {
    zipPath,
    entryCount: count,
    centralDir: { start: cdStart, size: cdSize },
    entries: list,
    knownPlaintextHints: knownPlaintextHints(entries),
  }
}

export function crack({ zipPath, known, cipherIndex, timeoutMs = 3600000 }) {
  const work = asciiCopy(zipPath)
  const args = ['-C', work]
  const ci = cipherIndex != null ? cipherIndex : null
  if (ci != null) args.push('--cipher-index', String(ci))
  if (!known || known.length === 0) throw new Error('必须提供已知明文 known=[{offset,hex},...]')
  for (const k of known) args.push('-x', String(k.offset), String(k.hex).toUpperCase())
  const r = spawnSync(BKCRACK, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  const m = out.match(/Keys\s+([0-9a-f]{8})\s+([0-9a-f]{8})\s+([0-9a-f]{8})/i)
  if (m) return { ok: true, keys: [m[1].toLowerCase(), m[2].toLowerCase(), m[3].toLowerCase()], output: out.slice(0, 4000) }
  if (r.status !== 0) return { ok: false, error: r.error ? r.error.message : 'bkcrack 退出码 ' + r.status, output: out.slice(0, 4000) }
  return { ok: false, output: out.slice(0, 4000) }
}

export function reset({ zipPath, keys, newPassword }) {
  if (!keys || keys.length !== 3) throw new Error('keys 必须是3个32位hex: [X,Y,Z]')
  const work = asciiCopy(zipPath)
  const outTmp = path.join(WORK, 'out_' + Date.now() + '.zip')
  const args = ['-C', work, '-k', String(keys[0]), String(keys[1]), String(keys[2]), '-U', outTmp, String(newPassword)]
  const r = spawnSync(BKCRACK, args, { encoding: 'utf8', timeout: 3600000, maxBuffer: 128 * 1024 * 1024 })
  const out = (r.stdout || '') + (r.stderr || '')
  if (!/Wrote unlocked archive/i.test(out) && r.status !== 0)
    return { ok: false, error: r.error ? r.error.message : 'bkcrack 退出码 ' + r.status, output: out.slice(0, 4000) }
  const ext = path.extname(zipPath)
  const base = path.basename(zipPath, ext)
  const finalPath = path.join(path.dirname(zipPath), base + '（' + newPassword + '）.zip')
  fs.copyFileSync(outTmp, finalPath)
  return { ok: true, outputZip: finalPath, password: newPassword, output: out.slice(0, 4000) }
}

export function decrypt({ zipPath, keys, outDir, cipherIndexes = null, timeoutMs = 3600000 }) {
  if (!keys || keys.length !== 3) throw new Error('keys 必须是3个32位hex: [X,Y,Z]')
  const { entries } = parseEntries(zipPath)
  const targets = cipherIndexes
    ? entries.filter((e) => cipherIndexes.includes(e.index))
    : entries.filter((e) => !e.isDir && e.csize > 0)
  const work = asciiCopy(zipPath)
  const dir = outDir || path.join(path.dirname(zipPath), path.basename(zipPath, path.extname(zipPath)) + '_解密')
  fs.mkdirSync(dir, { recursive: true })
  const results = []
  for (const e of targets) {
    if (e.isDir || e.csize === 0) continue
    const dec = path.join(WORK, 'dec_' + e.index + '_' + Date.now() + '.bin')
    const args = ['-C', work, '--cipher-index', String(e.index), '-k', String(keys[0]), String(keys[1]), String(keys[2]), '-d', dec]
    const r = spawnSync(BKCRACK, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024 })
    const out = (r.stdout || '') + (r.stderr || '')
    if (r.status !== 0) {
      results.push({ index: e.index, ok: false, name: decodeName(e.name), error: out.slice(0, 500) })
      continue
    }
    let data = fs.readFileSync(dec)
    if (e.method === 8) {
      try {
        data = zlib.inflateRawSync(data)
      } catch (err) {
        results.push({ index: e.index, ok: false, name: decodeName(e.name), error: 'deflate解压失败: ' + err.message })
        continue
      }
    }
    const crcOk = crc32(data) === e.crc
    const name = decodeName(e.name)
    const outPath = path.join(dir, name)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, data)
    results.push({ index: e.index, ok: true, name, size: data.length, crcOk })
  }
  const okCount = results.filter((x) => x.ok).length
  return { ok: okCount === targets.filter((e) => !e.isDir && e.csize > 0).length, outDir: dir, total: results.length, okCount, results }
}
