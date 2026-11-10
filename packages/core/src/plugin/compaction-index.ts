export * as CompactionIndexPlugin from "./compaction-index.js"

/**
 * Turns every compaction into two durable things: an index row and a set of
 * preferences that suit the work the session is actually doing.
 *
 * Summaries:
 *   index.jsonl        source of truth, one JSON object per line, appended and never
 *                      rewritten, so segments accumulate with no ceiling
 *   summaries/bN.md    full text, read on demand
 *   note               a rendered view of the newest segments
 *
 * The note is re-injected into every request and has a byte budget, so it holds
 * only the index; the JSONL keeps every row the note had to shed. Appending a line
 * is what makes this safe: there is no read-modify-rewrite step that could drop
 * segments the way an overwriting `write` does.
 *
 * Preferences:
 *   Stored as `pref.<domain>.<name>` rows in `instruction_entry`, next to the note.
 *   `removed` is the switch: the kernel renders only rows where it is false, so a
 *   refreshed set costs one upsert inside the same transaction as the note.
 *
 * Both triggers read the summary the kernel just produced. The summary states the
 * objective and the constraints, which is a better description of what a session is
 * doing than its title or its working directory.
 */

import { define } from "@opencode/plugin/effect/plugin"
import type { PluginInternal } from "./internal.js"
import { Effect, Stream } from "effect"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { InstructionEntry } from "../session/instruction-entry.js"

/** The note budget the note tool enforces. Keep in step with `MaxNoteBytes`. */
const NOTE_BUDGET = 32 * 1024
/** Rendered views stay below this so the budget is never the thing that fails a write. */
const NOTE_TARGET = 30 * 1024
const MAX_PER_SEGMENT = 4
const BULLET_CLIP = 76
const TOPIC_CLIP = 34

const NOTE_KEY = InstructionEntry.Key.make("note")
const COMPACT_TOOL = "compress"
const PREF_PREFIX = "pref."

const INDEX_FILE = "index.jsonl"
const NOTE_MARKER = "## 段落索引"
const BULLET_HEADING = "## 各段要点"
const DOMAIN_HEADING = "## 本会话生效的偏好域"

/**
 * Task domains a session can be matched against. A preference row is named
 * `pref.<domain>.<name>`, so the domain is both its tag and its lookup prefix.
 */
export const DOMAINS = [
  "ctf",
  "bounty",
  "packaging",
  "report",
  "image",
  "answer",
  "android",
  "proxy",
] as const
export type Domain = (typeof DOMAINS)[number]

/** One segment as stored in index.jsonl. */
export type Segment = {
  readonly n: number
  readonly t: string
  readonly b: string
  readonly topic: string
  readonly file: string
  readonly points: ReadonlyArray<string>
  /** Domains the summary was classified into, kept so the note can explain itself. */
  readonly domains?: ReadonlyArray<string>
}

export const summaryDir = (sessionID: string) =>
  path.join(os.homedir(), ".local", "share", "wlstudio", "summaries", sessionID)

const indexFile = (sessionID: string) => path.join(summaryDir(sessionID), INDEX_FILE)

const slug = (topic: string) => topic.replace(/[\\/:*?"<>|\s]+/gu, "").slice(0, 20) || "note"

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text)

const stamp = (at: number) => {
  const d = new Date(at)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

const firstHeading = (summary: string) => {
  for (const line of summary.split("\n")) {
    const text = line.trim()
    if (text.startsWith("#")) return text.replace(/^#+\s*/u, "").slice(0, TOPIC_CLIP)
  }
  return ""
}

/** The lines worth keeping in the rendered view: exclusions and conclusions. */
export const keyPoints = (summary: string, limit = MAX_PER_SEGMENT) => {
  const picked: string[] = []
  for (const line of summary.split("\n")) {
    const text = line.trim()
    if (!text || text.startsWith("#")) continue
    if (!/勿重试|已排除|不要重试|结论|注意|坑|失败|不可用|WrongAnswer/iu.test(text)) continue
    const clean = clip(text.replace(/^[-*]\s*/u, "").replace(/\*\*/gu, ""), BULLET_CLIP)
    if (clean && !picked.includes(clean)) picked.push(clean)
    if (picked.length >= limit) break
  }
  return picked
}

export const readIndex = (sessionID: string): Segment[] => {
  const file = indexFile(sessionID)
  if (!existsSync(file)) return []
  const segments: Segment[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const text = line.trim()
    if (!text) continue
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.n === "number" && typeof parsed?.topic === "string") segments.push(parsed)
    } catch {
      // A half-written last line from a crash: skip it, earlier rows still stand.
    }
  }
  return segments
}

export const appendIndex = (sessionID: string, segment: Segment) => {
  mkdirSync(summaryDir(sessionID), { recursive: true })
  appendFileSync(indexFile(sessionID), JSON.stringify(segment) + "\n", "utf8")
}

/** Renders the note from the index, shedding the oldest rows until it fits. */
export const renderNote = (
  segments: ReadonlyArray<Segment>,
  total: number,
  domains: ReadonlyArray<string> = [],
  budget = NOTE_TARGET,
) => {
  if (segments.length === 0) return ""

  const build = (rows: ReadonlyArray<Segment>) => {
    const omitted = total - rows.length
    const lines = [
      "# 摘要索引（每次压缩追加一段）",
      "",
      "> 这里只有索引。要看某段的完整内容，read 对应正文文件，不要凭记忆复述。",
      "",
    ]

    if (domains.length > 0) {
      lines.push(DOMAIN_HEADING, "", "`" + domains.join("`, `") + "`", "")
    }

    lines.push(
      NOTE_MARKER,
      "",
      "| 段 | 时间 | 边界 | 主题 | 正文 |",
      "|---|---|---|---|---|",
      ...rows.map(
        (s) =>
          `| b${s.n} | ${s.t} | ${s.b} | ${clip(s.topic || "未命名", TOPIC_CLIP)} | summaries/${s.file} |`,
      ),
      "",
    )

    if (omitted > 0) {
      lines.push(`上段之前另有 **${omitted}** 段较早的摘要，未在此展开。`, `完整索引：\`summaries/${INDEX_FILE}\``, "")
    }

    const withPoints = rows.filter((s) => s.points.length > 0)
    if (withPoints.length > 0) {
      lines.push(BULLET_HEADING, "")
      for (const s of withPoints) {
        lines.push(`**b${s.n}** ${clip(s.topic || "", TOPIC_CLIP)}`)
        for (const p of s.points) lines.push(`- ${p}`)
        lines.push("")
      }
    }
    return lines.join("\n")
  }

  let rows = [...segments]
  let text = build(rows)
  while (Buffer.byteLength(text, "utf8") > budget && rows.length > 1) {
    rows = rows.slice(Math.ceil(rows.length * 0.15) || 1)
    text = build(rows)
  }
  if (Buffer.byteLength(text, "utf8") > budget) {
    while (Buffer.byteLength(text, "utf8") > budget && text.length > 0) {
      text = text.slice(0, Math.floor(text.length * 0.9))
    }
  }
  return text
}

/** Reads the summary and topic out of a compress call, for either tool shape. */
export const readPayload = (input: unknown) => {
  if (!input || typeof input !== "object") return undefined
  const record = input as Record<string, any>
  const blocks = record.content
  const summary =
    Array.isArray(blocks) && blocks.length > 0 && typeof blocks[0]?.summary === "string" ? blocks[0].summary : ""
  if (!summary.trim()) return undefined
  const topic = typeof record.topic === "string" ? record.topic : firstHeading(summary)
  return { summary, topic }
}

/** A single bare token in backticks - a name, not a topic. CJK counts: `` `众测业务` `` is a label. */
const IDENTIFIER_SPAN = /^`[\w.\-\u4e00-\u9fff]{1,40}`$/u
/** A filesystem path: its segments are directory names, not subject matter. */
const PATH_LIKE = /\b[\w.-]+(?:[\\/][\w.-]+)+\b/gu
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/\S+/giu
const FENCED_BLOCK = /```[\s\S]*?```/gu
/** The `- 域: ...` header a stored segment carries. */
const DOMAIN_LINE = /^-\s*域[:：].*$/gmu
/** Preference row keys, e.g. `pref.ctf.flag-format`. The domain is part of the name. */
const PREF_KEY = /pref\.[\w.]+/gu

/**
 * Removes the parts of a summary that hold names instead of subject matter.
 *
 * Paths are the big one: `packages/core/src/plugin/` made bounty match through `src`,
 * because `src` there is a directory and not a security response center. Inline code is
 * next: a session that designs the preference tree names every domain (`ctf`, `bounty`,
 * `proxy`), so classifying on the raw text activates all of them - the vocabulary of the
 * feature cannot be evidence for using the feature. Spans that hold punctuation
 * (`` `flag{...}` ``, `` `adb shell` ``) are kept, since those are commands and literals.
 */
const plainText = (summary: string) =>
  summary
    .replace(FENCED_BLOCK, " ")
    .replace(URL_LIKE, " ")
    .replace(PATH_LIKE, " ")
    .replace(PREF_KEY, " ")
    .replace(/`[^`\n]*`/gu, (span) => (IDENTIFIER_SPAN.test(span) ? " " : span))
    .replace(DOMAIN_LINE, " ")

/**
 * Picks the domains a summary is about.
 *
 * The summary carries the objective and the constraints, so a keyword pass over it is
 * both cheap and well grounded. A model call would classify better, but it would also
 * cost a request on every compaction, so this stays deterministic and the misses remain
 * visible in the note's domain line for later correction.
 *
 * Each domain has strong and weak evidence. Strong evidence is unambiguous in this
 * context - `雷神`, `bkcrack`, `electron-builder`. Weak evidence is a word that also
 * occurs in other senses: `代理` is both a proxy server and a Unicode surrogate pair,
 * `截图` appears in a report as a deliverable, `图片` shows up in the phrase describing
 * image off-loading. One weak word therefore never activates a domain on its own - it
 * says an artefact exists, not that this is the kind of work being done.
 */
const SIGNALS: ReadonlyArray<readonly [Domain, RegExp, RegExp | null]> = [
  ["ctf", /flag\{|\bctf\b|writeup|\bwp\b|靶场|bkcrack|\bmisc\d|\bweb\d|osint|\bpwn\b/iu, /解题|题目/iu],
  ["bounty", /众测|雷神|bountyteam|赏金|漏洞提交|漏洞报告|审核意见/iu, /漏洞|审核/iu],
  [
    "packaging",
    /安装包|打包|electron-builder|\bnsis\b|installer\.nsh|asar|出包|rcedit|代码签名/iu,
    /\brelease\b|版本号|签名/iu,
  ],
  ["report", /实验报告|实验\d|\bdocx\b|作业|截图插入|排版|论文/iu, /报告|实验/iu],
  ["image", /像素|抠像|精灵|立绘|识图|文生图|视觉模型/iu, /图片|截图|视觉|透明/iu],
  ["answer", /智慧树|超星|题库|单选|多选|填空题/iu, /答题/iu],
  ["android", /安卓|\bapk\b|\badb\b|jadx|smali/iu, /安卓|apk/iu],
  [
    "proxy",
    /\bvpn\b|clash|7890|7891|\bsocks5?\b|tun\s*模式|http_proxy|科学上网|翻墙|代理服务器|代理软件/iu,
    /代理|proxy/iu,
  ],
]

/** How many distinct words from `pattern` occur in `text`. */
const distinctHits = (text: string, pattern: RegExp) => {
  const seen = new Set<string>()
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`)))
    seen.add(match[0].toLowerCase())
  return seen.size
}

/**
 * Two distinct weak words are treated as real signal. One is not: a single `代理` can be a
 * Unicode surrogate pair, a single `图片` can be the name of an off-loading feature.
 */
const WEAK_THRESHOLD = 2

export const classify = (summary: string): Domain[] => {
  const text = plainText(summary)
  const hits: Domain[] = []
  for (const [domain, strong, weak] of SIGNALS) {
    if (strong.test(text)) {
      hits.push(domain)
      continue
    }
    if (weak && distinctHits(text, weak) >= WEAK_THRESHOLD) hits.push(domain)
  }
  return hits
}

/**
 * Switches the preference rows for the detected domains on, and everything else off.
 *
 * `entries.list` hides removed rows, which is right for rendering but wrong here: a
 * preference that is currently off is exactly the one that has to be turned on. So
 * this reads the table snapshot, which carries both the `removed` flag and the value,
 * and flips rows in both directions. The value is needed because re-enabling means
 * writing that value back under the visible key.
 */
const switchPreferences = (
  entries: InstructionEntry.Interface,
  sessionID: Parameters<InstructionEntry.Interface["put"]>[0]["sessionID"],
  domains: ReadonlyArray<Domain>,
) =>
  Effect.gen(function* () {
    const rows = yield* entries.listAll(sessionID)
    const prefs = rows.filter((row) => row.key.startsWith(PREF_PREFIX))
    if (prefs.length === 0) return

    const wanted = domains.map((d) => `${PREF_PREFIX}${d}.`)

    for (const row of prefs) {
      const keep = wanted.some((prefix) => row.key.startsWith(prefix))
      if (keep === !row.removed) continue
      if (keep) {
        // Off but wanted: rewrite the value under the visible key, which clears removed.
        yield* entries.put({ sessionID, key: InstructionEntry.Key.make(row.key), value: row.value })
      } else {
        yield* entries.remove({ sessionID, key: InstructionEntry.Key.make(row.key) })
      }
    }
  })

/**
 * Stores one summary: body to disk, one line to index.jsonl, then the rendered note.
 * The note is a view, so writing it last means a failure there costs the view but
 * never the record.
 */
const record = (
  entries: InstructionEntry.Interface,
  sessionID: Parameters<InstructionEntry.Interface["put"]>[0]["sessionID"],
  payload: { summary: string; topic: string },
  boundary: string,
) =>
  Effect.gen(function* () {
    const existing = yield* Effect.sync(() => readIndex(sessionID))
    const number = existing.length + 1
    const domains = classify(payload.summary)
    const file = `b${number}-${slug(payload.topic)}.md`

    const segment: Segment = {
      n: number,
      t: stamp(Date.now()),
      b: boundary,
      topic: payload.topic,
      file,
      points: keyPoints(payload.summary),
      domains,
    }

    yield* Effect.sync(() => {
      try {
        const dir = summaryDir(sessionID)
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          path.join(dir, file),
          `# b${number}  ${payload.topic}\n\n- 边界: ${boundary}\n- 长度: ${payload.summary.length} 字\n- 域: ${domains.join(", ") || "未识别"}\n\n---\n\n${payload.summary}`,
          "utf8",
        )
      } catch {
        // A failed spill must not stop the index line; the row still records it.
      }
      try {
        appendIndex(sessionID, segment)
      } catch {
        // Same here: the note is still worth writing.
      }
    })

    yield* switchPreferences(entries, sessionID, domains)

    const all = [...existing, segment]
    const note = renderNote(all, all.length, domains)
    if (!note) return
    if (Buffer.byteLength(note, "utf8") > NOTE_BUDGET) return
    yield* entries.put({ sessionID, key: NOTE_KEY, value: note })
  })

export const Plugin = define({
  id: "opencode.compaction.index",
  effect: Effect.fn("CompactionIndexPlugin")(function* (ctx) {
    const entries = yield* InstructionEntry.Service

    // Path 1: a plugin-provided compress tool reports its summary in the tool result.
    yield* ctx.tool.hook("execute.after", (event) =>
      Effect.gen(function* () {
        if (event.tool !== COMPACT_TOOL) return
        if (event.status !== "completed") return
        const payload = readPayload(event.input)
        if (!payload) return
        yield* record(entries, event.sessionID, payload, String(event.id))
      }).pipe(Effect.catchCause(() => Effect.void)),
    )

    // Path 2: the kernel's own compaction. `text` is the summary it just produced,
    // which is the most accurate description of what the session is doing.
    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is any => event.type === "session.compaction.ended" && typeof event.data?.text === "string",
      ),
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const text = String(event.data.text).trim()
          if (!text) return
          yield* record(entries, event.data.sessionID, { summary: text, topic: firstHeading(text) }, "kernel")
        }).pipe(Effect.catchCause(() => Effect.void)),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)
