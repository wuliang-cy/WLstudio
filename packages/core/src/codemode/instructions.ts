export * as CodeModeInstructions from "./instructions.js"

import { searchSignature, toolExpression } from "@opencode/codemode"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import { CodeModeCatalog } from "./catalog.js"

// prettier-ignore
const prompt = (hasMoreTools: boolean) => `# Code Mode

使用 \`execute\` 工具调用下面列出的工具。它们不能被直接调用${hasMoreTools ? "，\`search\` 也不能。二者都" : "，它们"}只能在你传给 \`execute\` 的代码内部使用。

${hasMoreTools ? `这份目录是不完整的。在 \`execute\` 内部，用 \`search(...)\` 查找工具，然后用结果里的 \`path\` 调用它。\`search\` 是同步的，不要对它用 \`await\`，它不返回 Promise。不要猜工具名。

- ${searchSignature}` : "这份目录是完整的。不要猜工具名。"}

## 可用工具`

export function render(catalog: CodeModeCatalog.Summary) {
  if (catalog.total === 0)
    return "当前没有可用的 Code Mode 工具。后续的 Code Mode 目录更新可能会增减工具。只要没有可用的 Code Mode 工具，就不要调用 `execute`。"

  const tools = catalog.namespaces.flatMap((namespace) => {
    return [CodeModeCatalog.namespaceLine(namespace), ...namespace.entries.map((entry) => entry.line)]
  })

  return `${prompt(catalog.shown < catalog.total)}

${tools.join("\n")}`
}

export function update(previous: CodeModeCatalog.Summary, current: CodeModeCatalog.Summary) {
  const replacement = `Code Mode 工具目录已发生变化。此目录取代之前的 Code Mode 工具目录。

${render(current)}`
  if (current.total === 0) return replacement
  const previousComplete = previous.shown === previous.total
  const currentComplete = current.shown === current.total
  if (previousComplete !== currentComplete) return replacement

  const descriptions = Instructions.diffByKey(
    previous.namespaces.filter((namespace) => namespace.description !== undefined),
    current.namespaces.filter((namespace) => namespace.description !== undefined),
    (namespace) => namespace.name,
    (before, after) => before.description !== after.description,
  )
  if (descriptions.added.length > 0 || descriptions.removed.length > 0 || descriptions.changed.length > 0)
    return replacement

  const diff = Instructions.diffByKey(
    previous.namespaces.flatMap((namespace) => namespace.entries),
    current.namespaces.flatMap((namespace) => namespace.entries),
    (entry) => entry.path,
    (before, after) => before.line !== after.line,
  )
  const entriesChanged = diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0

  if (!currentComplete) {
    if (entriesChanged) return replacement
    const namespaces = Instructions.diffByKey(
      previous.namespaces,
      current.namespaces,
      (namespace) => namespace.name,
      (before, after) => before.count !== after.count,
    )
    const changed = namespaces.added.length > 0 || namespaces.removed.length > 0 || namespaces.changed.length > 0
    if (!changed) return replacement

    const parts = ["Code Mode 工具目录已发生变化。"]
    if (namespaces.added.length > 0) {
      parts.push(
        `有新的工具命名空间可用：${namespaces.added
          .map((namespace) => `\`${namespace.name}\`（${namespace.count} 个工具）`)
          .join("、")}。`,
      )
    }
    if (namespaces.changed.length > 0) {
      parts.push(
        `以下命名空间的清单已变化；在依赖之前的结果前请重新检索：${namespaces.changed
          .map((change) => `\`${change.current.name}\` 现在有 ${change.current.count} 个工具`)
          .join("、")}。`,
      )
    }
    if (namespaces.removed.length > 0) {
      parts.push(
        `以下工具命名空间已不再可用，禁止使用：${namespaces.removed
          .map((namespace) => `\`${namespace.name}\``)
          .join("、")}。`,
      )
    }
    const delta = parts.join("\n\n")
    if (delta.length < replacement.length) return delta
    return replacement
  }

  if (!entriesChanged) return replacement
  const parts = ["Code Mode 工具目录已发生变化。"]
  if (diff.added.length > 0) {
    parts.push(
      [
        "除了之前列出的工具之外，还有新工具可用：",
        ...diff.added.map((entry) => entry.line),
      ].join("\n"),
    )
  }
  if (diff.changed.length > 0) {
    parts.push(
      [
        "发生变化的工具条目取代之前列出的条目：",
        ...diff.changed.map((change) => change.current.line),
      ].join("\n"),
    )
  }
  if (diff.removed.length > 0) {
    parts.push(
      `以下工具已不再可用，禁止调用：${diff.removed
        .map((entry) => toolExpression(entry.path))
        .join(", ")}.`,
    )
  }
  const delta = parts.join("\n\n")
  if (delta.length < replacement.length) return delta
  return replacement
}

const key = Instructions.Key.make("core/codemode")
const codec = Schema.toCodecJson(CodeModeCatalog.Summary)

export const make = (inventory?: CodeModeCatalog.Inventory): Instructions.List => {
  const catalog = inventory === undefined ? Instructions.removed : CodeModeCatalog.summarize(inventory)
  return Instructions.make({
    key,
    codec,
    read: Effect.succeed(catalog),
    render: {
      initial: render,
      changed: update,
      removed: () => "Code Mode tools are no longer available. Do not use any previously listed Code Mode tools.",
    },
  })
}
