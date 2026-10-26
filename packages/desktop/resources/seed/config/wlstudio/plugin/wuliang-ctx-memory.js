// wuliang-ctx-memory —— 上下文成本优化插件（缓存友好 / append-only）
//
// 设计依据（见 WLstudio-ctx-upgrade/PLAN.md 与
// ex-bags\opencode上下文token优化经验.md §8）：
//   P1 只追加，不改写前缀：历史一旦写出就冻结；任何"回头改历史"都会打掉
//      DeepSeek 的硬盘前缀缓存（前缀一个字节不同，其后全部全价重算）。
//   P2 大内容在"产生那一刻"外置：落盘 + 留短引用，之后该位置永久稳定。
//   P3 用检索代替堆叠：经验包放外部可检索存储，只把相关片段追加到当前
//      用户消息尾部（不动 system、不改历史前缀）。
//
// 四个 hook：
//   1) experimental.chat.messages.transform —— (a) 把"最后一条 user 消息之前"的
//      图片（独立 FilePart 与 ToolPart.state.attachments）一次性外置为磁盘
//      路径。外置后该位置变成文本说明，下一轮不会再被识别为图片，因此
//      天然单调、不会反复改写同一位置。当前轮图片原样保留。(b) 每轮一律
//      剥离 reasoning part，避免把历史 reasoning 作为 reasoning_content
//      回传给模型（省 token + 稳定前缀）。
//   2) tool.execute.after —— 工具输出 > 12000 字符时落盘，只留"头 4KB + 说明
//      + 尾 1KB"。在产生那一刻定型（P2）。
//   3) chat.message —— 用当前用户消息对 ex-bags 做纯关键词/BM25 检索，把
//      top-k 片段作为新的 text part 追加到当前消息尾部（P3，缓存友好）。
//   4) experimental.session.compacting —— 提供极简压缩提示，让主模型产出
//      ≤2KB 的结构化 digest，压缩后真正落低，消除压缩震荡。
//
// 纯 Node：无第三方依赖、无网络、无模型、无子进程。
// 说明：PLAN 里的"会话常驻记忆注入 system"（experimental.chat.system.transform）
//      被有意省略——任何逐轮变化的 system 内容都会打掉前缀缓存；跨会话连续性
//      已由经验检索 + 交接文档承担。
//
// 卸载：删除本文件并重启即可。存量会话里已被外置的图片/输出不会再被还原。

import os from "os";
import fs from "fs";
import path from "path";
import crypto from "crypto";

// ---------- 路径 ----------
const BASE_DIR = path.join(os.tmpdir(), "opencode-ctx-guard");
const IMG_DIR = path.join(BASE_DIR, "images");
const OUT_DIR = path.join(BASE_DIR, "tool-output");

// ex-bags 位置：优先环境变量，其次用户工作区（安装版），最后兼容旧开发路径。
const EX_BAGS_DOMAINS = ["SEC", "CTF", "REV", "DEV", "OPS", "AI", "MOB", "GAME", "DOC", "DATA"];

// 安装时会在用户目录 seed 一个空的 ex-bags 骨架，它必须让位于真实库，
// 否则检索永远扫空目录，笔记里的相对路径也会全被判为不存在。
function countExperienceDocs(root) {
  let total = 0;
  for (const domain of EX_BAGS_DOMAINS) {
    try {
      const dir = path.join(root, domain);
      if (!fs.existsSync(dir)) continue;
      total += fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).length;
    } catch {
      /* ignore */
    }
  }
  return total;
}

function resolveExBagsDir() {
  // 经验库位置：显式环境变量 > 安装器写入的 WLSTUDIO_DATA > 旧版遗留位置。
  // 安装器把库放在安装盘（同盘、空间足），重装不会丢；不要再回落到开发者机器的
  // 绝对路径，否则换台机器会静默指向别人的旧库，造成「写入 A、检索读 B」的分裂。
  if (process.env.WLSTUDIO_EX_BAGS) return process.env.WLSTUDIO_EX_BAGS;
  const roots = [];
  if (process.env.WLSTUDIO_DATA) roots.push(path.join(process.env.WLSTUDIO_DATA, "ex-bags"));
  roots.push(path.join(os.homedir(), "WLstudio", "ex-bags"));
  const best = roots
    .filter((dir) => {
      try {
        return fs.existsSync(dir);
      } catch {
        return false;
      }
    })
    .map((dir) => ({ dir, docs: countExperienceDocs(dir) }))
    .sort((a, b) => b.docs - a.docs)[0];
  return best ? best.dir : roots[0];
}

const EX_BAGS_DIR = resolveExBagsDir();
const INDEX_FILE = path.join(EX_BAGS_DIR, ".index.json");

// ---------- 阈值 ----------
const TOOL_LIMIT = 12000;
const TOOL_HEAD = 4000;
const TOOL_TAIL = 1000;
const RETRIEVE_TOP_K = 3;
const RETRIEVE_MAX_CHARS = 1500;
const RETRIEVE_MIN_SCORE = 2.0;        // BM25 原始分阈值（宁高勿低）
const RETRIEVE_MIN_TERMS = 2;          // 查询实义词（去停用词）至少 2 个
const RETRIEVE_MIN_MATCHED = 2;        // 命中片段至少匹配 2 个实义词（宁可漏不可灌）
const CHUNK_MAX_CHARS = 3000;

const MIME_EXT = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// 生成一个合法的 Part id（opencode 的 TextPart 要求 id/sessionID/messageID 齐全，
// 缺任一个都会触发 SchemaError → 整轮 prompt 500 失败）。
function newPartId() {
  return (
    "prt_" +
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10)
  );
}

function isDataUrl(u) {
  return typeof u === "string" && /^data:image\/[a-z0-9.+-]+;base64,/i.test(u);
}

function parseDataUrl(u) {
  const comma = u.indexOf(",");
  const head = u.slice(5, comma);
  const mime = head.split(";")[0] || "image/png";
  const data = u.slice(comma + 1);
  return { mime, data };
}

// 以「长度 + 前 8KB sha1」做快速指纹（不含冒号，避免 Windows ADS）。
function fingerprint(u) {
  return (
    u.length +
    "h" +
    crypto.createHash("sha1").update(u.slice(0, 8192)).digest("hex").slice(0, 16)
  );
}

// 进程级图片落盘缓存：同一张图整个进程只写一次。
const IMAGE_CACHE = new Map();
let IMAGE_INDEX_LOADED = false;

function loadImageIndexOnce() {
  if (IMAGE_INDEX_LOADED) return;
  IMAGE_INDEX_LOADED = true;
  try {
    ensureDir(IMG_DIR);
    for (const f of fs.readdirSync(IMG_DIR)) {
      const m = /^img_(.+?)(\.[a-z0-9]+)?$/i.exec(f);
      if (m) IMAGE_CACHE.set(m[1], path.join(IMG_DIR, f));
    }
  } catch {
    /* ignore */
  }
}

function createImageSaver() {
  loadImageIndexOnce();
  return (dataUrl) => {
    const fp = fingerprint(dataUrl);
    if (IMAGE_CACHE.has(fp)) return IMAGE_CACHE.get(fp);
    const { mime, data } = parseDataUrl(dataUrl);
    const ext = MIME_EXT[mime] || ".png";
    const file = path.join(IMG_DIR, "img_" + fp + ext);
    try {
      ensureDir(IMG_DIR);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
    } catch {
      return null;
    }
    IMAGE_CACHE.set(fp, file);
    return file;
  };
}

function imageNote(filePath) {
  return (
    "[图片已外置以节省上下文: " +
    filePath +
    " —— 这是历史图片，需要查看内容时用 read 工具读取该路径]"
  );
}

// ---------- 纯函数：历史清理（图片外置 + reasoning 剥离） ----------
// 1) 只外置"早于最后一条 user 消息"的图片；当前轮保留。
// 2) 剥离所有 reasoning part：opencode 会把历史 assistant 的 reasoning 作为
//    reasoning_content 回传（已实测），每轮重发既费 token 又可能扰动缓存。
//    这里每轮一律剔除（确定性 → 发送前缀稳定，不破坏前缀缓存）。返回统计。
export function transformMessages(messages, saveImage) {
  const stats = {
      externalizedImages: 0,
      savedImages: 0,
      strippedReasoning: 0,
      externalizedTexts: 0,
    };
  if (!Array.isArray(messages)) return stats;

  for (const msg of messages) {
    const parts = msg?.parts;
    if (!Array.isArray(parts)) continue;
    const kept = [];
    let changed = false;
    for (const p of parts) {
      if (p && p.type === "reasoning") {
        stats.strippedReasoning++;
        changed = true;
        continue;
      }
      kept.push(p);
    }
    if (changed) msg.parts = kept;
  }

  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.info?.role === "user") lastUser = i;
  }

  for (let mi = 0; mi < messages.length; mi++) {
    if (mi >= lastUser) continue; // 当前轮（最后一条 user 及其之后）保留
    const parts = messages[mi]?.parts;
    if (!Array.isArray(parts)) continue;
    const newParts = [];
    for (const part of parts) {
      if (!part) continue;

      if (part.type === "file" && isDataUrl(part.url)) {
        const file = saveImage(part.url);
        stats.externalizedImages++;
        if (file) {
          stats.savedImages++;
          newParts.push({
            id: newPartId(),
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "text",
            text: imageNote(file),
          });
        }
        continue;
      }

      if (
        part.type === "tool" &&
        part.state &&
        Array.isArray(part.state.attachments) &&
        part.state.attachments.length
      ) {
        const kept = [];
        const notes = [];
        for (const att of part.state.attachments) {
          if (att && isDataUrl(att.url)) {
            const file = saveImage(att.url);
            stats.externalizedImages++;
            if (file) {
              stats.savedImages++;
              notes.push(imageNote(file));
            } else {
              kept.push(att);
            }
          } else {
            kept.push(att);
          }
        }
        part.state.attachments = kept;
        newParts.push(part);
        if (notes.length) {
          newParts.push({
            id: newPartId(),
            sessionID: part.sessionID,
            messageID: part.messageID,
            type: "text",
            text: notes.join("\n"),
          });
        }
        continue;
      }

      // A tool result can carry images and oversized text inside `state.content` instead of
      // `state.attachments`. `read` on a picture is the common case: the file part holds the whole
      // base64 payload, so a single screenshot would otherwise stay resident in every later request.
      // Rewrite those inner parts in place and leave a path note behind.
      if (part.type === "tool" && part.state && Array.isArray(part.state.content)) {
        let touched = false;
        const rewritten = [];
        for (const inner of part.state.content) {
          if (!inner || typeof inner !== "object") {
            rewritten.push(inner);
            continue;
          }
          if (inner.type === "file" && isDataUrl(inner.url)) {
            const file = saveImage(inner.url);
            stats.externalizedImages++;
            if (file) {
              stats.savedImages++;
              touched = true;
              rewritten.push({ type: "text", text: imageNote(file) });
              continue;
            }
            rewritten.push(inner);
            continue;
          }
          if (inner.type === "text" && typeof inner.text === "string" && inner.text.length > TOOL_LIMIT) {
            const shortened = shortenToolOutput(inner.text, saveText);
            if (shortened.externalized) {
              stats.externalizedTexts++;
              touched = true;
              rewritten.push({ type: "text", text: shortened.text });
              continue;
            }
          }
          rewritten.push(inner);
        }
        if (touched) part.state.content = rewritten;
        newParts.push(part);
        continue;
      }

      newParts.push(part);
    }
    messages[mi].parts = newParts;
  }
  return stats;
}

// ---------- 纯函数：工具输出外置 ----------
export function shortenToolOutput(text, saveText, limit = TOOL_LIMIT) {
  if (typeof text !== "string" || text.length <= limit) {
    return { text, externalized: false };
  }
  const head = text.slice(0, TOOL_HEAD);
  const tail = text.slice(-TOOL_TAIL);
  const firstLine = (text.split(/\r?\n/, 1)[0] || "").slice(0, 200);
  const omitted = Math.max(0, text.length - head.length - tail.length);
  const file = saveText(text);
  const note =
    "\n\n...[标题: " +
    firstLine +
    "；已省略中间 " +
    omitted +
    " 字符；完整输出: " +
    (file || "(写入失败)") +
    "，可用 read/grep 取回]...\n\n";
  return { text: head + note + tail, externalized: true, file };
}

// ---------- 检索：tokenize / 索引 / BM25 ----------
function tokenize(text) {
  const tokens = [];
  if (typeof text !== "string" || !text) return tokens;
  const ascii = text.toLowerCase().match(/[a-z0-9_]{2,}/g);
  if (ascii) for (const w of ascii) tokens.push(w);
  const cjk = text.match(/[\u3400-\u9fff]+/g);
  if (cjk) {
    for (const run of cjk) {
      for (let i = 0; i < run.length; i++) {
        tokens.push(run[i]);
        if (i + 1 < run.length) tokens.push(run.slice(i, i + 2));
      }
    }
  }
  return tokens;
}

// ---------- 检索闸门：噪声词过滤 ----------
// 停用词/泛用词：命中则不计入"实义词"，用于挡住"感觉如何/继续/测试一下"这类泛句。
const STOP_WORDS = new Set([
  "ok", "test", "hello", "hi", "yes", "no", "the", "and", "for", "with", "this", "that", "you", "are",
  // CJK 单字功能词
  "的", "了", "是", "在", "我", "有", "和", "就", "不", "人", "都", "一", "个", "上", "也", "很",
  "到", "说", "要", "去", "你", "会", "着", "没", "看", "好", "这", "那", "么", "啊", "呢", "吧",
  "吗", "做", "下", "来", "过", "再", "还", "只", "被", "把", "给", "让", "又", "想", "对", "能",
  // CJK 泛用词（常见但无检索价值）
  "感觉", "如何", "怎么", "怎样", "继续", "测试", "试试", "现在", "然后", "因为", "所以", "但是",
  "如果", "可以", "麻烦", "帮我", "一下", "什么", "问题", "处理", "解决", "做好", "好了", "没有",
  "不是", "这个", "那个", "一个", "东西", "时候", "方式", "方法", "操作", "内容", "结果", "看看",
  "这里", "那里", "出现", "进行", "需要", "使用", "开始", "完毕", "完成", "搞定", "帮我看看", "谢谢",
  "写进", "进去", "出来", "打开", "关闭", "删除",
]);

// 查询侧 token：只用 ASCII 词（≥3）与 CJK 二元词，过滤停用词；丢弃单字（避免生僻字高 idf 假命中）。
function contentTokens(text) {
  const toks = [];
  if (typeof text !== "string" || !text) return toks;
  const ascii = text.toLowerCase().match(/[a-z0-9_]{3,}/g);
  if (ascii) for (const w of ascii) if (!STOP_WORDS.has(w)) toks.push(w);
  const cjk = text.match(/[\u3400-\u9fff]+/g);
  if (cjk) {
    for (const run of cjk) {
      for (let i = 0; i + 1 < run.length; i++) {
        const bg = run.slice(i, i + 2);
        if (!STOP_WORDS.has(bg)) toks.push(bg);
      }
    }
  }
  return toks;
}

// 把一个大块按空行切成 <=CHUNK_MAX_CHARS 的小块。
function splitLarge(title, text) {
  if (text.length <= CHUNK_MAX_CHARS) return [text];
  const paras = text.split(/\n\s*\n/);
  const out = [];
  let cur = "";
  for (const p of paras) {
    if (cur && (cur + "\n\n" + p).length > CHUNK_MAX_CHARS) {
      out.push(cur);
      cur = p;
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
    while (cur.length > CHUNK_MAX_CHARS) {
      out.push(cur.slice(0, CHUNK_MAX_CHARS));
      cur = cur.slice(CHUNK_MAX_CHARS);
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function splitChunks(fileName, content) {
  const lines = content.split(/\r?\n/);
  const raw = [];
  let cur = { title: "", lines: [] };
  let inCode = false;
  const push = () => {
    const text = cur.lines.join("\n").trim();
    if (text) raw.push({ title: cur.title, text });
  };
  for (const line of lines) {
    if (/^```/.test(line)) inCode = !inCode;
    if (!inCode && /^##\s+/.test(line)) {
      push();
      cur = { title: line.replace(/^##\s+/, "").trim(), lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  push();

  const chunks = [];
  for (const r of raw) {
    for (const piece of splitLarge(r.title, r.text)) {
      if (piece.trim()) chunks.push({ file: fileName, title: r.title, text: piece });
    }
  }
  return chunks;
}

function scanFiles(dir) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ name, full, mtimeMs: st.mtimeMs, size: st.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function finalizeIndex(chunks) {
  const df = new Map();
  const postings = [];
  let totalLen = 0;
  for (const c of chunks) {
    const toks = tokenize(c.title + "\n" + c.text);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    postings.push({ tf, len: toks.length });
    totalLen += toks.length;
  }
  const N = chunks.length;
  return { chunks, postings, df, N, avgdl: N ? totalLen / N : 0 };
}

let CACHE = { signature: "", index: null };
const LAST_INJECT = new Map(); // sessionID -> 上次注入内容指纹（同一任务不重复灌）

function buildIndex(dir) {
  const files = scanFiles(dir);
  const signature = files
    .map((f) => f.name + ":" + f.size + ":" + Math.round(f.mtimeMs))
    .join("|");

  if (CACHE.signature === signature && CACHE.index) return CACHE.index;

  if (files.length) {
    try {
      const disk = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
      if (disk && disk.signature === signature && Array.isArray(disk.chunks)) {
        const index = finalizeIndex(disk.chunks);
        CACHE = { signature, index };
        return index;
      }
    } catch {
      /* ignore */
    }
  }

  const chunks = [];
  for (const f of files) {
    if (f.size > 4 * 1024 * 1024) continue;
    let content = "";
    try {
      content = fs.readFileSync(f.full, "utf8");
    } catch {
      continue;
    }
    for (const c of splitChunks(f.name, content)) chunks.push(c);
  }
  try {
    ensureDir(dir);
    fs.writeFileSync(
      INDEX_FILE,
      JSON.stringify({ signature, builtAt: Date.now(), chunks }),
      "utf8"
    );
  } catch {
    /* ignore */
  }
  const index = finalizeIndex(chunks);
  CACHE = { signature, index };
  return index;
}

function search(queryTokens, index, topK, minMatched = 1) {
  if (!index || !index.N) return [];
  const qtf = new Map();
  for (const t of queryTokens) qtf.set(t, (qtf.get(t) || 0) + 1);
  if (!qtf.size) return [];
  const k1 = 1.5;
  const b = 0.75;
  const scored = [];
  for (let i = 0; i < index.chunks.length; i++) {
    const { tf, len } = index.postings[i];
    let score = 0;
    let matched = 0;
    for (const [t, qc] of qtf) {
      const f = tf.get(t);
      if (!f) continue;
      matched++;
      const df = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.N - df + 0.5) / (df + 0.5));
      const denom = f + k1 * (1 - b + b * (len / (index.avgdl || 1)));
      score += (idf * (f * (k1 + 1))) / denom * (1 + Math.log(qc));
    }
    if (score > 0 && matched >= minMatched) scored.push({ i, score, matched });
  }
  scored.sort((a, b2) => b2.score - a.score);
  return scored.slice(0, topK);
}

// 返回一段可直接追加到消息尾部的文本（无命中返回 ""）。
// 强制闸门：①查询实义词数量 ②相关度+匹配实义词数 ③长度上限。
export function retrieveSnippets(query, opts = {}) {
  try {
    const dir = opts.dir || EX_BAGS_DIR;
    const topK = opts.topK || RETRIEVE_TOP_K;
    const maxChars = opts.maxChars || RETRIEVE_MAX_CHARS;
    const minScore = opts.minScore == null ? RETRIEVE_MIN_SCORE : opts.minScore;
    const minTerms = opts.minTerms == null ? RETRIEVE_MIN_TERMS : opts.minTerms;
    const minMatched = opts.minMatched == null ? RETRIEVE_MIN_MATCHED : opts.minMatched;

    // 闸门 1：查询实义词数量。太短/太泛（如"感觉如何""继续"）直接不注入。
    const qTokens = contentTokens(query);
    if (new Set(qTokens).size < minTerms) return "";

    const index = buildIndex(dir);
    // 闸门 2：相关度 + 至少匹配 minMatched 个实义词
    const hits = search(qTokens, index, topK, minMatched).filter(
      (h) => h.score >= minScore
    );
    if (!hits.length) return "";

    // 闸门 3：注入总长硬上限
    let out = "";
    const usedFiles = new Set();
    for (const h of hits) {
      const c = index.chunks[h.i];
      if (usedFiles.has(c.file) && out.length > maxChars * 0.6) continue;
      usedFiles.add(c.file);
      const header = "### " + c.file + (c.title ? " › " + c.title : "");
      const body = c.text.length > 1200 ? c.text.slice(0, 1200) + " …" : c.text;
      const block = header + "\n" + body + "\n\n";
      if (out.length + block.length > maxChars) {
        const remain = maxChars - out.length;
        if (remain > 200) out += block.slice(0, remain);
        break;
      }
      out += block;
    }
    return out.trim();
  } catch {
    return "";
  }
}

// ---------- 插件（openCode v2 Promise 版） ----------
// v2 消息模型：Message = { id?, role, content: ContentPart[] }，ContentPart 按 `type` 打标。
// 与 v1 的 { info, parts } 不同，故此处直接读写 message.content。
const log = (level, message) => {
  try {
    process.stdout.write(
      "[wuliang-ctx-memory] " + level + " " + message + "\n"
    );
  } catch {
    /* ignore */
  }
};

const saveText = (text) => {
  try {
    ensureDir(OUT_DIR);
    const h = crypto
      .createHash("sha1")
      .update(text.slice(0, 8192))
      .digest("hex")
      .slice(0, 16);
    const file = path.join(OUT_DIR, "out_" + text.length + "_" + h + ".txt");
    fs.writeFileSync(file, text, "utf8");
    return file;
  } catch {
    return null;
  }
};

// 从一条消息的 content 里取全部文本。
const messageText = (message) => {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
};

// 剥离所有消息里的 reasoning 片段（v2 part type 字符串为 "reasoning"）。
const stripReasoning = (messages) => {
  let stripped = 0;
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) continue;
    const kept = message.content.filter((p) => p?.type !== "reasoning");
    if (kept.length !== message.content.length) {
      stripped += message.content.length - kept.length;
      message.content = kept;
    }
  }
  return stripped;
};

const setup = async (ctx) => {
  log("info", "plugin loaded");
  try {
    ensureDir(BASE_DIR);
    fs.writeFileSync(
      path.join(BASE_DIR, "memory-loaded.marker"),
      new Date().toISOString() + " pid=" + process.pid,
      "utf8"
    );
  } catch {
    /* ignore */
  }

  // 1) 每轮请求前：剥离 reasoning + 把 ex-bags 检索片段追加到当前用户消息尾部（P1/P3，缓存友好）。
  await ctx.session.hook("context", (event) => {
    try {
      const messages = event?.messages;
      if (!Array.isArray(messages)) return;

      stripReasoning(messages);

      // 找最后一条 user 消息，用它的文本作为检索 query。
      let lastUser = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "user") {
          lastUser = i;
          break;
        }
      }
      if (lastUser < 0) return;
      const q = messageText(messages[lastUser]);
      if (!q.trim()) return;

      const snips = retrieveSnippets(q, {
        topK: RETRIEVE_TOP_K,
        maxChars: RETRIEVE_MAX_CHARS,
        minScore: RETRIEVE_MIN_SCORE,
        minTerms: RETRIEVE_MIN_TERMS,
        minMatched: RETRIEVE_MIN_MATCHED,
      });
      if (!snips) return;

      // 闸门 4：session 级去重——同一任务不重复灌同样内容。
      const sessionID = event?.sessionID;
      const fp = crypto
        .createHash("sha1")
        .update(snips)
        .digest("hex")
        .slice(0, 16);
      if (sessionID && LAST_INJECT.get(sessionID) === fp) return;
      if (sessionID) LAST_INJECT.set(sessionID, fp);

      const text =
        "\n\n[相关经验片段（本地关键词检索 ex-bags，供参考，可能与当前任务无关，请自行判断）]\n" +
        snips;
      const target = messages[lastUser];
      if (!Array.isArray(target.content)) target.content = [];
      target.content.push({ type: "text", text });
    } catch (err) {
      log("error", "context hook error: " + (err?.message || err));
    }
  });

  // 2) 大工具输出在产生那一刻落盘（v2 结果在 event.result.output）。
  await ctx.tool.hook("execute.after", (event) => {
    try {
      if (!event || event.status !== "completed") return;
      const result = event.result;
      if (!result || typeof result.output !== "string") return;
      const r = shortenToolOutput(result.output, saveText);
      if (r.externalized) result.output = r.text;
    } catch (err) {
      log("error", "tool.execute.after error: " + (err?.message || err));
    }
  });

  return () => {};
};

export default {
  id: "wuliang-ctx-memory",
  setup,
};
