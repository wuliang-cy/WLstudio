import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@opencode/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  // The template placeholder must be substituted, not shipped to the model verbatim.
  expect(prompt).not.toContain("${OPENCODE_TOOL_GUIDANCE}")
  expect(prompt).not.toContain("${WLSTUDIO_TOOL_GUIDANCE}")
  expect(prompt).toContain("用 edit 工具对已有文本文件做局部改动")
})

test("tool guidance only covers the tools that are actually present", () => {
  const prompt = SessionSystemPrompt.make(["read"])
  expect(prompt).not.toContain("用 edit 工具对已有文本文件做局部改动")
  expect(prompt).not.toContain("优先使用专用工具")
})

test("the system prompt asks for reasoning in the user's language when no language is configured", () => {
  const prompt = SessionSystemPrompt.make(["read"])
  expect(prompt).toContain("# Language")
  expect(prompt).toContain("Think and reply in the same language as the user's most recent message")
})

test("a configured language pins the reasoning language by name", () => {
  const prompt = SessionSystemPrompt.make(["read"], "zh")
  expect(prompt).toContain("# Language — 简体中文")
  // The draft itself must be bound, not only the visible reply.
  expect(prompt).toContain("Thinking")
  expect(prompt).toContain("简体中文")
})

test("language false emits no language section at all", () => {
  const prompt = SessionSystemPrompt.make(["read"], false)
  expect(prompt).not.toContain("# Language")
})
