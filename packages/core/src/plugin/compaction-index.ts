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

/**
 * Picks the domains a summary is about.
 *
 * The summary carries the objective and the constraints, so a keyword pass over it
 * is both cheap and well grounded: `flag{}` only shows up in CTF work, `VPN` and
 * `众测` only in bounty work, and so on. A model call would classify better, but it
 * would also cost a request on every compaction, so this stays deterministic and the
 * misses are visible in the note's domain line for later correction.
 */
const SIGNALS: ReadonlyArray<readonly [Domain, RegExp]> = [
  ["ctf", /\bctf\b|flag\{|解题|题目|writeup|wp\b|靶场|bkcrack|misc\d|web\d|osint/iu],
  ["bounty", /众测|漏洞提交|雷神|bountyteam|审核意见|src\b|赏金|漏洞报告/iu],
  ["packaging", /安装包|打包|electron-builder|nsis|installer\.nsh|asar|出包|release|签名|rcedit/iu],
  ["report", /实验报告|实验\d|docx|报告|作业|截图插入|排版/iu],
  ["image", /图片|截图|像素|抠像|精灵|立绘|识图|视觉/iu],
  ["answer", /答题|智慧树|超星|题库|单选|多选|填空题/iu],
  ["android", /安卓|apk|adb|重打包|逆向|jadx|smali/iu],
  ["proxy", /vpn|代理|proxy|clash|7890|tun\s*模式/iu],
]

export const classify = (summary: string): Domain[] => {
  const hits: Domain[] = []
  for (const [domain, pattern] of SIGNALS) {
    if (pattern.test(summary)) hits.push(domain)
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
