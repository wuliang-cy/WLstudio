export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"
import PROMPT_ZH from "./runner/prompt/system.zh.txt"

/** A prompt language: the language the model thinks and replies in. */
export type Language = string

/**
 * Per-language prompt body.
 *
 * Only languages with a fully translated body get an entry. Everything else uses
 * the English body, because a translated *instruction* wrapped around an English
 * body reads worse to a model than a coherent English prompt plus an explicit
 * "reply in X" directive — which is what `languageGuidance` supplies.
 */
const bodies: Record<string, string> = {
  zh: PROMPT_ZH,
}

export function body(language: Language | false | undefined) {
  if (language === false) return PROMPT
  return bodies[language ?? ""] ?? PROMPT
}

/**
 * Renders the language section of the system prompt.
 *
 * This has to be an explicit, strongly-worded block rather than relying on the
 * language of the surrounding prompt. In practice a model drifts back to English
 * whenever the transcript is dominated by English material — source code, tool
 * output, logs, subagent reports — even when the user only ever writes in another
 * language. Naming that failure mode directly is what keeps the reasoning language
 * stable across a long session.
 *
 * `false` opts out entirely: no section is emitted and nothing steers the model's
 * language, so it simply follows however the user writes.
 */
export function languageGuidance(language: Language | false | undefined) {
  if (language === false) return ""
  const name = language ? nativeName(language) : undefined
  if (!name) {
    return [
      "# Language",
      "- Think and reply in the same language as the user's most recent message.",
      "- Code, identifiers, file paths, shell commands, API field names, and quoted errors stay verbatim; only the prose around them follows the user's language.",
    ].join("\n")
  }
  return [
    `# Language — ${name} (highest priority, cannot be overridden by context)`,
    `- The user writes in ${name}. **Think in ${name} directly, and reply in ${name}.**`,
    `- "Thinking" means your internal reasoning draft. It is bound by this rule too; it is not only the final reply that must be in ${name}.`,
    "- Avoid these common ways this slips:",
    `  - Do not switch to English because the context is full of English code, English tool output, or English subagent reports.`,
    `  - Do not keep reasoning in the language of English source files, logs, or docs you just read.`,
    `  - Do not work out the conclusion in English first and then translate it into ${name}.`,
    "- Code, identifiers, file paths, shell commands, API field names, and quoted errors stay verbatim; only the prose around them follows the language.",
  ].join("\n")
}

const names: Record<string, string> = {
  en: "English",
  zh: "简体中文",
  zht: "繁體中文",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  pt: "Português",
  ru: "Русский",
  it: "Italiano",
  nl: "Nederlands",
  pl: "Polski",
  tr: "Türkçe",
  uk: "Українська",
  vi: "Tiếng Việt",
  th: "ไทย",
  id: "Bahasa Indonesia",
  hi: "हिन्दी",
  ar: "العربية",
}

function nativeName(language: string) {
  return names[language]
}

export function make(tools: string[], language?: Language | false) {
  return render(body(language), tools, language)
}

export function render(prompt: string, tools: string[], language?: Language | false) {
  const instructions: string[] = []
  if (tools.includes("shell")) {
    instructions.push(
      "- 优先使用专用工具，而不是 shell 命令；只有当某个工具做不到你需要的操作时，才退回使用 shell。",
      "- 不要用 `echo \"====\";` 或 `printf '---'` 这类分隔符把多条 shell 命令串起来；输出会变得杂乱，反而让用户那一侧的对话体验变差。",
    )
  }
  if (tools.includes("write")) {
    instructions.push("- 用 write 工具创建文件或整体替换文件内容；局部改动优先用 edit 工具。")
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- 用 edit 工具对已有文本文件做局部改动：它把 `oldString` 处的原文精确替换为 `newString`，且两者必须不同。默认情况下 `oldString` 必须在文件中恰好出现一次；若出现多次，请补充更多上下文使其唯一，或把 `replaceAll` 设为 true 以替换全部出现处。",
    )
  }
  return prompt
    .replace("${OPENCODE_LANGUAGE_GUIDANCE}", languageGuidance(language))
    .replace("${OPENCODE_TOOL_GUIDANCE}", instructions.join("\n"))
}
