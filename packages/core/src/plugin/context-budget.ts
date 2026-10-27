export * as ContextBudgetPlugin from "./context-budget.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { SessionRequest } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import os from "os"
import path from "node:path"
import type { PluginInternal } from "./internal.js"

/** How many images the current turn may keep verbatim; older ones become paths on disk. */
const KEEP_RECENT_IMAGES = 2

/** Soft ceiling for one request body; past this the oldest long texts get shortened. */
const REQUEST_SOFT_LIMIT = 6 * 1024 * 1024

/** A text part longer than this is considered long enough to shorten. */
const TEXT_LIMIT = 12000

/** Kept short so the note itself costs almost nothing. */
const TEXT_HEAD = 4000
const TEXT_TAIL = 1000

const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
}

// ---------------------------------------------------------------------------
// Spilling to disk
// ---------------------------------------------------------------------------

function imageDir() {
  return path.join(os.tmpdir(), "opencode-ctx-guard", "images")
}

function textDir() {
  return path.join(os.tmpdir(), "opencode-ctx-guard", "tool-output")
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/**
 * `data:image/png;base64,xxxx` written next to the other cache files, returning the absolute path.
 *
 * The name is derived from the payload so the same screenshot re-read twice maps to one file
 * instead of growing the cache on every turn.
 */
function saveDataUrl(dataUrl: string): string | undefined {
  const comma = dataUrl.indexOf(",")
  if (comma < 0) return undefined
  const header = dataUrl.slice(5, comma)
  const mime = (header.split(";")[0] || "image/png").toLowerCase()
  if (!mime.startsWith("image/")) return undefined
  const base64 = dataUrl.slice(comma + 1)
  const ext = IMAGE_MIME_EXT[mime] ?? ".png"
  const fingerprint = base64.length + "h" + createHash("sha1").update(base64.slice(0, 8192)).digest("hex").slice(0, 16)
  const file = path.join(imageDir(), "img_" + fingerprint + ext)
  try {
    if (!existsSync(file)) {
      ensureDir(imageDir())
      writeFileSync(file, Buffer.from(base64, "base64"))
    }
    return file
  } catch {
    return undefined
  }
}

function saveText(text: string): string | undefined {
  try {
    ensureDir(textDir())
    const hash = createHash("sha1").update(text.slice(0, 8192)).digest("hex").slice(0, 16)
    const file = path.join(textDir(), "out_" + text.length + "_" + hash + ".txt")
    writeFileSync(file, text, "utf8")
    return file
  } catch {
    return undefined
  }
}

const imageNote = (file: string) =>
  `[图片已外置以节省上下文: ${file} —— 这是历史图片，需要查看内容时用 read 工具读取该路径]`

/**
 * Cut a long text down to its head and tail, keeping the whole thing on disk.
 *
 * The first line is preserved in the note because it usually names what the output was (a path, a
 * command, a table header), which is what makes the kept part useful on its own.
 */
function shortenText(text: string, limit = TEXT_LIMIT) {
  if (text.length <= limit) return { text, changed: false as const }
  const head = text.slice(0, TEXT_HEAD)
  const tail = text.slice(-TEXT_TAIL)
  const firstLine = (text.split(/\r?\n/, 1)[0] ?? "").slice(0, 200)
  const omitted = Math.max(0, text.length - head.length - tail.length)
  const file = saveText(text)
  const note =
    "\n\n...[标题: " +
    firstLine +
    "；已省略中间 " +
    omitted +
    " 字符；完整输出 " +
    (file ?? "(写入失败)") +
    "，可用 read/grep 取回]...\n\n"
  return { text: head + note + tail, changed: true as const }
}

// ---------------------------------------------------------------------------
// Rewriting one request
// ---------------------------------------------------------------------------

const isDataUrl = (value: unknown): value is string =>
  typeof value === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(value)

interface Stats {
  images: number
  trimmed: number
}

/**
 * Replace historical images with notes pointing at the files.
 *
 * Two rules, and the second one matters as much as the first: everything before the last user
 * message is background and never needs to be re-read as pixels, while within the current turn only
 * the newest few survive. An agent that reads a dozen screenshots in one reply would otherwise push
 * the body past the gateway limit in a single turn, which is exactly how a session ends up stuck.
 *
 * A request with no user message is a compaction or title call operating on a synthesized
 * transcript; leave it untouched so the summary still sees what it is summarizing.
 */
function externalizeImages(messages: SessionRequest["messages"], stats: Stats) {
  let lastUser = -1
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i
  if (lastUser < 0) return

  const countImage = (part: any): number => {
    if (!part || typeof part !== "object") return 0
    if (part.type === "media" && part.media) return 1
    if (part.type === "tool-result" && part.result?.type === "content" && Array.isArray(part.result.value))
      return part.result.value.filter((inner: any) => inner?.type === "file" && isDataUrl(inner.uri)).length
    return 0
  }

  let inTurn = 0
  for (let mi = lastUser; mi < messages.length; mi++) {
    for (const part of messages[mi]?.content ?? []) inTurn += countImage(part)
  }
  const dropFirstN = inTurn <= KEEP_RECENT_IMAGES ? 0 : inTurn - KEEP_RECENT_IMAGES

  let seenInTurn = 0
  const shouldDrop = (isHistory: boolean) => {
    if (isHistory) return true
    seenInTurn++
    return seenInTurn <= dropFirstN
  }

  for (let mi = 0; mi < messages.length; mi++) {
    const message: any = messages[mi]
    if (!message || !Array.isArray(message.content)) continue
    const isHistory = mi < lastUser
    for (let pi = 0; pi < message.content.length; pi++) {
      const part: any = message.content[pi]
      if (!part || typeof part !== "object") continue

      // a) A media part carrying the bytes directly.
      if (part.type === "media" && part.media?.source) {
        if (!shouldDrop(isHistory)) continue
        const source = part.media.source
        const dataUrl =
          source.type === "base64" && typeof source.data === "string"
            ? `data:${source.mediaType ?? "image/png"};base64,${source.data}`
            : source.type === "bytes" && source.data instanceof Uint8Array
              ? `data:${source.mediaType ?? "image/png"};base64,${Buffer.from(source.data).toString("base64")}`
              : undefined
        if (!dataUrl) continue
        const file = saveDataUrl(dataUrl)
        if (!file) continue
        message.content[pi] = { type: "text", text: imageNote(file) }
        stats.images++
        continue
      }

      // b) A file part inside a tool result, which is how `read` returns an image.
      if (part.type === "tool-result" && part.result?.type === "content" && Array.isArray(part.result.value)) {
        let touched = false
        // The request carries readonly arrays, while the plugin rewrites them in place; cast at the
        // boundary instead of threading a mutable copy through the whole walk.
        const value = part.result.value as any[]
        const mapped = value.map((inner: any) => {
          if (inner?.type === "file" && isDataUrl(inner.uri)) {
            if (!shouldDrop(isHistory)) return inner
            const file = saveDataUrl(inner.uri)
            if (!file) return inner
            stats.images++
            touched = true
            return { type: "text", text: imageNote(file) }
          }
          if (inner?.type === "text" && typeof inner.text === "string" && inner.text.length > TEXT_LIMIT) {
            const cut = shortenText(inner.text)
            if (cut.changed) {
              stats.trimmed++
              touched = true
              return { type: "text", text: cut.text }
            }
          }
          return inner
        })
        value.splice(0, value.length, ...mapped)
        part.result.value = value
        if (touched) message.content[pi] = part
      }
    }
  }
}

/** Last resort for a body still too big: shorten the oldest long texts until it fits. */
function trimOversize(messages: SessionRequest["messages"], stats: Stats) {
  let total = 0
  const longTexts: Array<{ mi: number; pi: number }> = []
  for (let mi = 0; mi < messages.length; mi++) {
    const content: readonly any[] = messages[mi]?.content ?? []
    for (let pi = 0; pi < content.length; pi++) {
      const part: any = content[pi]
      if (!part || typeof part !== "object") continue
      if (part.type === "text" && typeof part.text === "string") {
        total += part.text.length
        if (part.text.length > TEXT_LIMIT) longTexts.push({ mi, pi })
      } else if (part.type === "tool-result" && Array.isArray(part.result?.value)) {
        for (const inner of part.result.value) {
          if (inner?.type === "text" && typeof inner.text === "string") total += inner.text.length
          else if (inner?.type === "file" && typeof inner.uri === "string") total += inner.uri.length
        }
      }
    }
  }
  if (total <= REQUEST_SOFT_LIMIT) return
  for (const { mi, pi } of longTexts) {
    if (total <= REQUEST_SOFT_LIMIT) break
    const message: any = messages[mi]
    if (!message) continue
    const part: any = message.content[pi]
    const cut = shortenText(part.text)
    if (!cut.changed) continue
    total -= part.text.length - cut.text.length
    message.content[pi] = { type: "text", text: cut.text }
    stats.trimmed++
  }
}

/** Exported for tests: rewrites one request in place and reports what it changed. */
export const transformRequest = (messages: SessionRequest["messages"]) => {
  const stats: Stats = { images: 0, trimmed: 0 }
  externalizeImages(messages, stats)
  trimOversize(messages, stats)
  return stats
}

// ---------------------------------------------------------------------------
// Plugin shell
// ---------------------------------------------------------------------------

export const Plugin = define({
  id: "opencode.context.budget",
  effect: Effect.fn("ContextBudgetPlugin")(function* (ctx) {
    const hook = (event: SessionRequest) =>
      Effect.sync(() => {
        const stats = transformRequest(event.messages)
        if (stats.images > 0 || stats.trimmed > 0) {
          process.stdout.write(
            `[context-budget] externalized ${stats.images} image(s), trimmed ${stats.trimmed} text(s)\n`,
          )
        }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
} satisfies PluginInternal.InternalPlugin)
