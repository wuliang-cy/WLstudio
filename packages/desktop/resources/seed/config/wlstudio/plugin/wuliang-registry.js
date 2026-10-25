import fs from "fs"

const BINARY_EXTS = new Set([
  "docx", "xlsx", "pptx", "doc", "xls", "ppt",
  "zip", "rar", "7z", "tar", "gz", "bz2",
  "exe", "dll", "so", "dylib",
  "odt", "ods", "odp",
  "woff", "woff2", "ttf", "otf", "eot",
])

const EXT_NAMES = {
  docx: "Word 文档", xlsx: "Excel 表格", pptx: "PowerPoint 演示文稿",
  doc: "Word 文档", xls: "Excel 表格", ppt: "PowerPoint 演示文稿",
  zip: "ZIP 压缩包", rar: "RAR 压缩包", "7z": "7z 压缩包",
  exe: "可执行文件", dll: "动态链接库",
}

function getExt(p) {
  const dot = p.lastIndexOf(".")
  return dot === -1 ? "" : p.slice(dot + 1).toLowerCase()
}

function getFileName(p) {
  const sep = p.includes("\\") ? "\\" : "/"
  const parts = p.split(sep)
  return parts[parts.length - 1] || p
}

function buildFriendlyMsg(ext, filePath) {
  const name = EXT_NAMES[ext] || `.${ext}`
  const fileName = getFileName(filePath)
  return (
    `[无法读取 ${fileName}]\n` +
    `这是一个 ${name}（.${ext}）文件，属于二进制格式，无法直接作为文本读取。\n\n` +
    `如果你需要我处理该文件的内容，可以尝试：\n` +
    `1. 将文件转换为 .txt、.md、.csv 或 .pdf 格式后再发给我\n` +
    `2. 我可以尝试用相关工具提取内容（如 python-docx 提取 .docx）\n` +
    `3. 直接将文件内容复制粘贴到对话中`
  )
}

const log = (level, message) => {
  try {
    process.stdout.write("[wuliang-registry] " + level + " " + message + "\n")
  } catch {}
}

const setup = async (ctx) => {
  log("info", "wuliang-registry plugin loaded")

  // /vf and /vc are plain markdown commands under the config commands directory; no hook needed.
  // Only the read-tool binary friendly message remains.
  await ctx.tool.hook("execute.after", (event) => {
    if (event?.tool !== "read") return
    if (event.status !== "error") return
    const input = event.input || {}
    const filePath = input.filePath || input.path || ""
    const ext = getExt(filePath)
    if (!ext || !BINARY_EXTS.has(ext)) return
    if (event.error) event.error.message = buildFriendlyMsg(ext, filePath)
  })

  return () => {}
}

export default { id: "wuliang-registry", setup }
