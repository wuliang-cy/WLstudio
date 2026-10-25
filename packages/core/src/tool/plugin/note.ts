/**
 * Session note: a durable, per-session scratchpad the model can read and write.
 *
 * Backed by `InstructionEntry`, so the current note is rendered into the
 * instruction baseline of every model request and survives compaction. Only
 * changes are narrated chronologically, which keeps the steering surface small.
 *
 * Scope discipline: the note holds facts about *this specific task target*
 * (endpoints, field names, stack, limits). Reusable method belongs in the
 * skill/experience tree, and task progress belongs in the handoff document.
 *
 * Reference shortcut: because the note is re-rendered into every request, a
 * relative path recorded here costs nothing at retrieval time and lets the model
 * open the right experience document immediately instead of running a BM25 pass
 * and hoping the top hit is the right one.
 */
export * as NoteTool from "./note.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Effect, Schema } from "effect"
import path from "node:path"
import os from "node:os"
import { existsSync, readdirSync } from "node:fs"
import { InstructionEntry } from "../../session/instruction-entry.js"

export const name = "note"

/** Instruction entry key backing this session's note. */
const NoteKey = InstructionEntry.Key.make("note")

const MaxNoteBytes = 8 * 1024

export const Input = Schema.Struct({
  action: Schema.Literals(["read", "write", "append", "clear"]).annotate({
    description:
      "read returns the current note; write replaces the whole note; append adds one line/section; clear removes the note.",
  }),
  text: Schema.optionalKey(Schema.String).annotate({
    description: "Note body for `write`, or the block to add for `append`. Ignored by `read` and `clear`.",
  }),
  refs: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Experience-document paths to link into the note (e.g. `SEC/接口可达性判定.md`, `DEV/Electron内置CLI内核重建与替换.md`). Stored as a `## 参考` section so later turns open them directly instead of searching. Plain `action=read` also reports which recorded paths still exist.",
  }),
})

export const Output = Schema.Struct({
  action: Schema.Literals(["read", "write", "append", "clear"]),
  bytes: Schema.Number,
  note: Schema.String,
  /** Recorded reference paths with existence status, resolved against the experience root. */
  refs: Schema.Array(Schema.Struct({ path: Schema.String, exists: Schema.Boolean })),
})

export type Output = typeof Output.Type

const decodeNote = (value: unknown): string => {
  if (typeof value === "string") return value
  if (value === null || value === undefined) return ""
  return JSON.stringify(value, null, 2)
}

/**
 * Computes the next note body. `append` adds a blank-line separated block,
 * `write` replaces everything. Exported so the merge rules stay unit-testable
 * without a database.
 */
export const merge = (current: string, action: "write" | "append", text: string): string =>
  action === "append" && current.length > 0 ? `${current.replace(/\s+$/u, "")}\n\n${text}` : text

export const exceedsBudget = (note: string) => Buffer.byteLength(note, "utf8") > MaxNoteBytes

const REF_HEADING = "## 参考"

/**
 * Normalizes a recorded reference to a path relative to the experience root.
 * Accepts forward or back slashes, and strips any prefix up to and including
 * `ex-bags`, so a pasted absolute path still lands on the short form.
 */
export const normalizeRef = (input: string): string => {
  const trimmed = input.trim().replace(/^["'`]|["'`]$/gu, "")
  const unified = trimmed.replaceAll("\\", "/")
  const marker = unified.toLowerCase().lastIndexOf("ex-bags/")
  const relative = marker >= 0 ? unified.slice(marker + "ex-bags/".length) : unified
  return relative.replace(/^\.\//u, "").replace(/^\/+/u, "")
}

/** Returns the prose above the `## 参考` section, without that section. */
export const stripRefs = (note: string): string => {
  const marker = note.indexOf(`\n${REF_HEADING}`)
  const body = marker >= 0 ? note.slice(0, marker) : note
  return body.replace(/\s+$/u, "")
}

/**
 * Replaces or appends the `## 参考` section while leaving the prose above it intact.
 * Any previously appended prose is preserved because only the section is rewritten.
 */
export const withRefs = (note: string, refs: ReadonlyArray<string>): string => {
  const normalized = Array.from(new Set(refs.map(normalizeRef).filter((entry) => entry.length > 0)))
  const trimmedBody = stripRefs(note)
  if (normalized.length === 0) return trimmedBody
  const block = [REF_HEADING, ...normalized.map((entry) => `- ${entry}`)].join("\n")
  return trimmedBody.length === 0 ? block : `${trimmedBody}\n\n${block}`
}

/** Reads back the reference paths currently recorded in a note body. */
export const readRefs = (note: string): ReadonlyArray<string> => {
  const marker = note.indexOf(`\n${REF_HEADING}`)
  if (marker < 0) return []
  return note
    .slice(marker + 1)
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0)
}

/** Canonical domain folders, used to tell a real library from an empty seed skeleton. */
const DOMAINS = ["SEC", "CTF", "REV", "DEV", "OPS", "AI", "MOB", "GAME", "DOC", "DATA"] as const

/** Counts experience documents under a root; exported for the resolution tests. */
export const countDocuments = (root: string): number => {
  try {
    let total = 0
    for (const domain of DOMAINS) {
      const dir = path.join(root, domain)
      if (!existsSync(dir)) continue
      total += readdirSync(dir).filter((entry) => entry.toLowerCase().endsWith(".md")).length
    }
    return total
  } catch {
    return 0
  }
}

/**
 * Resolves the experience tree, preferring whichever candidate actually holds
 * documents. A seeded-but-empty `~/WLstudio/ex-bags` must not shadow a real
 * library: an empty skeleton would make every recorded reference look missing.
 */
export const resolveExperienceDir = (): string | undefined => {
  const configured = process.env.WLSTUDIO_EX_BAGS?.trim()
  if (configured && existsSync(configured)) return configured
  // Only the install-derived location is a candidate. An absolute author path here would leak a
  // developer's machine into every distributed build and mean nothing on a user's machine.
  const dataRoot = process.env.WLSTUDIO_DATA?.trim()
  const candidates = [
    dataRoot ? path.join(dataRoot, "ex-bags") : undefined,
    path.join(os.homedir(), "WLstudio", "ex-bags"),
  ].filter((entry): entry is string => !!entry && existsSync(entry))
  if (candidates.length === 0) return configured
  const ranked = candidates.map((entry) => ({ entry, documents: countDocuments(entry) }))
  const populated = ranked.filter((candidate) => candidate.documents > 0).sort((a, b) => b.documents - a.documents)
  if (populated.length > 0) return populated[0]!.entry
  return ranked[0]!.entry
}

/**
 * Resolves recorded references against the experience root. The plugin may only
 * describe locations: a missing root or missing file is reported, never guessed.
 */
export const checkRefs = (
  experienceDir: string | undefined,
  refs: ReadonlyArray<string>,
): ReadonlyArray<{ path: string; exists: boolean }> => {
  if (refs.length === 0) return []
  if (experienceDir === undefined) return refs.map((entry) => ({ path: entry, exists: false }))
  return refs.map((entry) => ({ path: entry, exists: existsSync(path.join(experienceDir, entry)) }))
}

export const Plugin = {
  id: "opencode.tool.note",
  effect: Effect.fn("NoteTool.Plugin")(function* (ctx: Context) {
    const entries = yield* InstructionEntry.Service

    const experienceDir = yield* Effect.sync(() => resolveExperienceDir())

    const current = Effect.fnUntraced(function* (sessionID: Parameters<typeof entries.list>[0]) {
      const rows = yield* entries.list(sessionID)
      const row = rows.find((candidate) => candidate.key === NoteKey)
      return decodeNote(row?.value)
    })

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description: [
            "Read or update this session's note: a durable scratchpad automatically included in every request, so it survives compaction.",
            "",
            "Write down hard facts you would otherwise lose and would need later: exact URLs and HTTP methods, request/response field names, the target's stack and auth scheme, rate-limit thresholds, confirmed working payloads, and open questions.",
            "",
            "Also pass `refs` with the experience-document paths this task relies on (for example `SEC/接口可达性判定.md`). They are kept in a `## 参考` section inside the note, so every later request sees them without a search: open the path directly instead of running a retrieval pass and hoping for the right hit.",
            "",
            "Do not use it for reusable method (that belongs in the experience tree), for task progress (that belongs in the handoff document), or for rules (that belongs in preferences). Keep it factual, deduplicated, and under 8 KB.",
          ].join("\n"),
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const before = yield* current(context.sessionID)

              if (input.action === "read") {
                const recorded = readRefs(before)
                return {
                  output: {
                    action: input.action,
                    bytes: Buffer.byteLength(before, "utf8"),
                    note: before,
                    refs: checkRefs(experienceDir, recorded),
                  },
                  content: before.length === 0 ? "(this session has no note yet)" : before,
                }
              }

              if (input.action === "clear") {
                yield* entries.remove({ sessionID: context.sessionID, key: NoteKey })
                return {
                  output: { action: input.action, bytes: 0, note: "", refs: [] },
                  content: "Cleared the session note.",
                }
              }

              const addition = input.text ?? ""
              const incoming = input.refs ?? []
              if (addition.trim().length === 0 && incoming.length === 0)
                return yield* new ToolFailure({
                  message: `Provide \`text\`, or \`refs\`, for \`${input.action}\`.`,
                })

              // A refs-only call keeps the existing prose and just rewrites the section.
              // Prose edits operate on the body above `## 参考`, otherwise append would
              // land after the section and be discarded by the rewrite.
              const merged =
                addition.trim().length === 0
                  ? stripRefs(before)
                  : merge(stripRefs(before), input.action === "append" ? "append" : "write", addition)
              const next = incoming.length > 0 ? withRefs(merged, [...readRefs(before), ...incoming]) : merged

              const bytes = Buffer.byteLength(next, "utf8")
              if (exceedsBudget(next))
                return yield* new ToolFailure({
                  message: `The session note would be ${bytes} bytes, over the ${MaxNoteBytes}-byte budget. Condense it: keep facts that are hard to rediscover, drop anything already recorded elsewhere.`,
                })

              yield* entries.put({ sessionID: context.sessionID, key: NoteKey, value: next })

              const refs = checkRefs(experienceDir, readRefs(next))
              const missing = refs.filter((entry) => !entry.exists).map((entry) => entry.path)
              return {
                output: { action: input.action, bytes, note: next, refs },
                content: [
                  `Saved the session note (${bytes} bytes). It is included in every subsequent request in this session.`,
                  refs.length > 0 ? `References: ${refs.length} recorded.` : "",
                  missing.length > 0
                    ? `Not found under the experience root, fix the path: ${missing.join(", ")}`
                    : "",
                ]
                  .filter((line) => line.length > 0)
                  .join(" "),
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to ${input.action} the session note`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
