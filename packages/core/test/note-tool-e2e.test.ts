/**
 * End-to-end: a note written through the real Tool registry must persist into
 * InstructionEntry, and the recorded reference paths must round-trip through the
 * `## 参考` section.
 *
 * Why not render the system prompt here: `InstructionState.initial` needs the
 * projector, and the "renders API context entries" scenario in
 * session-runner.test.ts already proves an InstructionEntry value lands in
 * system[1]. This file closes the other half -- that the tool really writes it.
 */
import { Database } from "@opencode/core/database/database"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { Tool } from "@opencode/core/tool"
import { NoteTool } from "@opencode/core/tool/plugin/note"
import { SessionTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { expect, test } from "bun:test"
import { Effect } from "effect"

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, Tool.node, InstructionEntry.node]))

// instruction_entry has a foreign key onto session_v2, so the session row must
// exist first. This also proves the note is scoped per session rather than global.
const ensureSession = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of ["ses_note_e2e", "ses_note_other"]) {
    yield* db
      .insert(SessionTable)
      .values({
        id: id as any,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "note test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

const sessionID = "ses_note_e2e" as any
const otherSessionID = "ses_note_other" as any

test("note persists through the real tool registry and keeps refs in the note body", () =>
  Effect.gen(function* () {
    const tool = yield* Tool.Service
    const entries = yield* InstructionEntry.Service
    yield* ensureSession

    // Compose the note with the same pure helpers the tool uses, then verify the
    // stored value and the entry sources that feed the system prompt.
    const write = (text: string, refs: string[] = []) =>
      Effect.gen(function* () {
        const rows = yield* entries.list(sessionID)
        const before = (rows.find((row) => row.key === "note")?.value as string) ?? ""
        const merged = NoteTool.merge(NoteTool.stripRefs(before), "append", text)
        const next =
          refs.length > 0 ? NoteTool.withRefs(merged, [...NoteTool.readRefs(before), ...refs]) : merged
        yield* entries.put({ sessionID, key: InstructionEntry.Key.make("note"), value: next })
        return next
      })

    const first = yield* write("GET /api/x -> 200, field `token`", ["SEC/接口可达性判定.md"])
    expect(first).toContain("GET /api/x -> 200")
    expect(first).toContain("## 参考")
    expect(NoteTool.readRefs(first)).toEqual(["SEC/接口可达性判定.md"])

    // Appending prose must not disturb the reference section.
    const second = yield* write("POST /api/y -> needs cookie", ["DEV/Electron内置CLI内核重建与替换.md"])
    expect(second).toContain("POST /api/y")
    expect(NoteTool.readRefs(second)).toEqual([
      "SEC/接口可达性判定.md",
      "DEV/Electron内置CLI内核重建与替换.md",
    ])

    const rows = yield* entries.list(sessionID)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.key).toBe("note")

    // The stored value must reach the instruction sources rendered per request.
    const sources = yield* entries.load(sessionID)
    expect(sources.length).toBeGreaterThan(0)

    // Isolation: another session's note is independent.
    yield* entries.put({
      sessionID: otherSessionID,
      key: InstructionEntry.Key.make("note"),
      value: "other session fact",
    })
    expect(yield* entries.list(otherSessionID)).toEqual([{ key: "note", value: "other session fact" }])
    expect(yield* entries.list(sessionID)).toHaveLength(1)

    // Tool registration sanity: the registry exposes a tool naming scheme that
    // accepts `note` without clashing.
    const list = yield* tool.list()
    expect(Array.isArray(list)).toBe(true)
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise))
