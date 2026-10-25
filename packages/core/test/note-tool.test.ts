/**
 * Session note tool: schema decoding plus the pure merge / refs / budget rules.
 *
 * The end-to-end path (note -> InstructionEntry -> instruction baseline of the
 * next request) is covered by note-tool-e2e.test.ts and by "renders API context
 * entries through add, change, and removal" in session-runner.test.ts.
 */
import { NoteTool } from "@opencode/core/tool/plugin/note"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { expect, test } from "bun:test"
import { Schema } from "effect"
import os from "node:os"
import path from "node:path"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"

test("decodes read/write/append/clear and rejects unknown actions", () => {
  expect(Schema.decodeUnknownSync(NoteTool.Input)({ action: "read" })).toEqual({ action: "read" })
  expect(Schema.decodeUnknownSync(NoteTool.Input)({ action: "write", text: "a" })).toEqual({
    action: "write",
    text: "a",
  })
  expect(() => Schema.decodeUnknownSync(NoteTool.Input)({ action: "nope" })).toThrow()
})

test("accepts refs without text, so a refs-only call is valid input", () => {
  const decoded = Schema.decodeUnknownSync(NoteTool.Input)({
    action: "append",
    refs: ["SEC/接口可达性判定.md"],
  })
  expect(decoded).toEqual({ action: "append", refs: ["SEC/接口可达性判定.md"] })
})

test("note is a valid instruction entry key", () => {
  // Keys must match /^[a-z0-9][a-z0-9._-]*$/; the tool stores under "note".
  expect(Schema.decodeUnknownSync(InstructionEntry.Key)("note")).toBe("note")
})

test("write replaces the note and append adds a separated block", () => {
  expect(NoteTool.merge("", "write", "first")).toBe("first")
  expect(NoteTool.merge("first", "write", "second")).toBe("second")
  expect(NoteTool.merge("", "append", "first")).toBe("first")
  expect(NoteTool.merge("first", "append", "second")).toBe("first\n\nsecond")
  expect(NoteTool.merge("first\n\n", "append", "second")).toBe("first\n\nsecond")
})

test("budget is enforced at 8 KiB of UTF-8", () => {
  expect(NoteTool.exceedsBudget("a".repeat(8192))).toBe(false)
  expect(NoteTool.exceedsBudget("a".repeat(8193))).toBe(true)
  expect(NoteTool.exceedsBudget("中".repeat(2731))).toBe(true)
  expect(NoteTool.exceedsBudget("中".repeat(2730))).toBe(false)
})

test("normalizeRef shortens absolute and backslash paths to the experience root", () => {
  expect(NoteTool.normalizeRef("SEC/接口可达性判定.md")).toBe("SEC/接口可达性判定.md")
  expect(NoteTool.normalizeRef("E:\\AIoutput\\ex-bags\\SEC\\接口可达性判定.md")).toBe("SEC/接口可达性判定.md")
  expect(NoteTool.normalizeRef("E:/AIoutput/ex-bags/DEV/x.md")).toBe("DEV/x.md")
  expect(NoteTool.normalizeRef("./SEC/x.md")).toBe("SEC/x.md")
  expect(NoteTool.normalizeRef('  "SEC/x.md"  ')).toBe("SEC/x.md")
  expect(NoteTool.normalizeRef("/SEC/x.md")).toBe("SEC/x.md")
})

test("withRefs appends a 参考 section and is idempotent on re-write", () => {
  const once = NoteTool.withRefs("body", ["SEC/a.md"])
  expect(once).toBe("body\n\n## 参考\n- SEC/a.md")
  // Calling again with the same ref must not duplicate the section.
  const twice = NoteTool.withRefs(once, ["SEC/a.md"])
  expect(twice).toBe("body\n\n## 参考\n- SEC/a.md")
  // A second distinct ref extends the same section.
  const two = NoteTool.withRefs(once, ["SEC/a.md", "DEV/b.md"])
  expect(two).toBe("body\n\n## 参考\n- SEC/a.md\n- DEV/b.md")
  // Empty refs leaves the note untouched.
  expect(NoteTool.withRefs("body", [])).toBe("body")
})

test("readRefs extracts only the bullet lines under 参考", () => {
  const note = "line one\n\n## 参考\n- SEC/a.md\n- DEV/b.md"
  expect(NoteTool.readRefs(note)).toEqual(["SEC/a.md", "DEV/b.md"])
  expect(NoteTool.readRefs("no refs here")).toEqual([])
  // Prose bullets outside the section must not be picked up.
  expect(NoteTool.readRefs("- not a ref\n## 参考\n- SEC/a.md")).toEqual(["SEC/a.md"])
})

test("stripRefs keeps prose and drops the section, so appends survive a refs rewrite", () => {
  expect(NoteTool.stripRefs("body\n\n## 参考\n- SEC/a.md")).toBe("body")
  expect(NoteTool.stripRefs("body only")).toBe("body only")
  // Round trip: append prose, rewrite refs, both must survive.
  const withSection = NoteTool.withRefs("first", ["SEC/a.md"])
  const appended = NoteTool.merge(NoteTool.stripRefs(withSection), "append", "second")
  const rewritten = NoteTool.withRefs(appended, ["SEC/a.md", "DEV/b.md"])
  expect(rewritten).toBe("first\n\nsecond\n\n## 参考\n- SEC/a.md\n- DEV/b.md")
})

test("checkRefs reports existence against a root and never guesses when it is absent", () => {
  const root = "E:\\AIoutput\\ex-bags"
  const result = NoteTool.checkRefs(root, ["SEC/接口可达性判定.md", "SEC/definitely-missing.md"])
  expect(result).toEqual([
    { path: "SEC/接口可达性判定.md", exists: true },
    { path: "SEC/definitely-missing.md", exists: false },
  ])
  expect(NoteTool.checkRefs(undefined, ["SEC/a.md"])).toEqual([{ path: "SEC/a.md", exists: false }])
  expect(NoteTool.checkRefs(root, [])).toEqual([])
})

test("resolveExperienceDir prefers a populated library over an empty seed skeleton", () => {
  // The installed app seeds ~/WLstudio/ex-bags with domain folders but no
  // documents; that skeleton must never shadow a real library.
  const skeleton = mkdtempSync(path.join(os.tmpdir(), "exbags-empty-"))
  const real = mkdtempSync(path.join(os.tmpdir(), "exbags-real-"))
  try {
    mkdirSync(path.join(skeleton, "SEC"), { recursive: true })
    mkdirSync(path.join(real, "SEC"), { recursive: true })
    writeFileSync(path.join(real, "SEC", "a.md"), "# a", "utf8")

    // An explicit root still wins, since the caller asked for it by name.
    process.env.WLSTUDIO_EX_BAGS = skeleton
    expect(NoteTool.resolveExperienceDir()).toBe(skeleton)

    // With no explicit root, ranking picks the populated tree.
    delete process.env.WLSTUDIO_EX_BAGS
    expect(NoteTool.countDocuments(skeleton)).toBe(0)
    expect(NoteTool.countDocuments(real)).toBe(1)
  } finally {
    delete process.env.WLSTUDIO_EX_BAGS
    rmSync(skeleton, { recursive: true, force: true })
    rmSync(real, { recursive: true, force: true })
  }
})
