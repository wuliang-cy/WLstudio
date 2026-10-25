import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";
import { pathToFileURL } from "url";

const SERVICE = "wuliang-read-binary";

const BINARY_EXTS = new Set([
    "docx", "xlsx", "pptx", "doc", "xls", "ppt",
    "odt", "ods", "odp",
    "zip", "rar", "7z", "tar", "gz", "bz2",
    "mp3", "wav", "ogg", "flac", "aac", "wma", "m4a",
    "mp4", "avi", "mkv", "mov", "wmv", "flv", "webm",
    "jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "ico",
    "pdf",
]);

// 图片/PDF 不在 read 钩子里拦截，交给 wuliang-image-vision 插件决定
// （模型有原生视觉时直通 read，无视觉时才渲染/转文字）
const VISION_HANDLED_EXTS = new Set([
    "jpg", "jpeg", "png", "gif", "bmp", "svg", "webp", "ico", "pdf",
]);

const EXT_NAMES = {
    docx: "Word 文档", xlsx: "Excel 表格", pptx: "PowerPoint 演示文稿",
    doc: "Word 文档", xls: "Excel 表格", ppt: "PowerPoint 演示文稿",
    zip: "ZIP 压缩包", rar: "RAR 压缩包", "7z": "7z 压缩包",
    odt: "OpenDocument 文本", ods: "OpenDocument 表格", odp: "OpenDocument 演示文稿",
    mp3: "MP3 音频", wav: "WAV 音频", ogg: "OGG 音频", flac: "FLAC 音频",
    aac: "AAC 音频", wma: "WMA 音频", m4a: "M4A 音频",
    mp4: "MP4 视频", avi: "AVI 视频", mkv: "MKV 视频", mov: "MOV 视频",
    wmv: "WMV 视频", flv: "FLV 视频", webm: "WebM 视频",
    jpg: "JPEG 图片", jpeg: "JPEG 图片", png: "PNG 图片", gif: "GIF 图片",
    bmp: "BMP 图片", svg: "SVG 图片", webp: "WebP 图片", ico: "ICO 图标",
    pdf: "PDF 文档",
};

const TMP_DIR = path.join(os.tmpdir(), "opencode-read-binary");

function nodeModulesCandidates() {
    const out = [];
    if (process.env.WLSTUDIO_NODE_MODULES) out.push(process.env.WLSTUDIO_NODE_MODULES);
    const home = os.homedir();
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    out.push(path.join(xdg, "wlstudio", "node_modules"));
    out.push(path.join(xdg, "opencode", "node_modules"));
    out.push(path.join(process.cwd(), "node_modules"));
    return out;
}

function findNodeModules() {
    for (const base of nodeModulesCandidates()) {
        if (fs.existsSync(path.join(base, "mammoth"))) return base;
    }
    return null;
}

function scriptsDir() {
    const home = os.homedir();
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    const candidates = [
        path.join(xdg, "wlstudio", "scripts"),
        path.join(xdg, "opencode", "plugins", "wuliang-read-binary", "scripts"),
    ];
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, "write-binary.py"))) return c;
    }
    return candidates[0];
}

function toFileURL(p) { return pathToFileURL(path.normalize(p)).href; }

async function readDocx(filePath, nm) {
    if (!nm) return `[错误] 未找到 node_modules，无法读取 .docx 文件`;
    const mammoth = await import(toFileURL(path.join(nm, "mammoth", "lib", "index.js")));
    const result = await mammoth.extractRawText({ path: filePath });
    const meta = [];
    if (result.messages?.length) meta.push(`[转换警告: ${result.messages.length} 条]`);
    return meta.length ? meta.join("\n") + "\n\n" + result.value : result.value;
}

async function readXlsx(filePath, nm) {
    if (!nm) return `[错误] 未找到 node_modules，无法读取 .xlsx 文件`;
    const XLSX = await import(toFileURL(path.join(nm, "xlsx", "xlsx.mjs")));
    const buf = await fs.promises.readFile(filePath);
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts = [];
    for (const name of wb.SheetNames) {
        const sheet = wb.Sheets[name];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        const rows = csv.split("\n").filter(r => r.trim());
        parts.push(`=== 工作表: ${name} (${rows.length} 行) ===\n${csv}`);
    }
    return parts.join("\n\n");
}

async function readPptx(filePath, nm) {
    if (!nm) return `[错误] 未找到 node_modules，无法读取 .pptx 文件`;
    const AdmZip = (await import(toFileURL(path.join(nm, "adm-zip", "adm-zip.js")))).default;
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const parts = [];
    for (const entry of entries) {
        if (!entry.isDirectory && entry.entryName.match(/ppt\/slides\/slide\d+\.xml$/)) {
            const xml = entry.getData().toString("utf-8");
            const texts = [];
            const re = /<a:t>([^<]*)<\/a:t>/g;
            let m;
            while ((m = re.exec(xml)) !== null) { if (m[1].trim()) texts.push(m[1]); }
            const slideNum = entry.entryName.match(/slide(\d+)\.xml$/)?.[1] || "?";
            if (texts.length) parts.push(`--- 幻灯片 ${slideNum} ---\n${texts.join(" ")}`);
        }
    }
    return parts.length ? parts.join("\n\n") : "[此 PPTX 未提取到文本内容]";
}

async function readZip(filePath, nm) {
    if (!nm) return `[错误] 未找到 node_modules，无法读取 .zip 文件`;
    const AdmZip = (await import(toFileURL(path.join(nm, "adm-zip", "adm-zip.js")))).default;
    const zip = new AdmZip(filePath);
    const entries = zip.getEntries();
    const parts = [`[ZIP 压缩包: ${entries.length} 个文件/目录]\n`];
    const readableExts = new Set([
        "txt", "md", "json", "yaml", "yml", "xml", "csv", "tsv",
        "js", "ts", "jsx", "tsx", "py", "rb", "rs", "go", "java",
        "c", "cpp", "h", "hpp", "cs", "css", "html", "htm", "sql",
        "sh", "bat", "ps1", "toml", "ini", "cfg", "conf", "log",
    ]);
    const textEntries = [];
    for (const entry of entries) {
        const name = entry.entryName;
        const size = entry.header.size;
        parts.push(`  ${name}${entry.isDirectory ? "/" : ""} (${formatSize(size)})`);
        if (!entry.isDirectory) {
            const ext = name.split(".").pop()?.toLowerCase() || "";
            if (readableExts.has(ext) && size < 100_000) textEntries.push(entry);
        }
    }
    if (textEntries.length > 0 && textEntries.length <= 10) {
        parts.push(`\n[可读文件内容:]`);
        for (const entry of textEntries) {
            try {
                const content = entry.getData().toString("utf-8");
                parts.push(`\n--- ${entry.entryName} ---\n${content.slice(0, 2000)}${content.length > 2000 ? "\n... (已截断)" : ""}`);
            } catch {}
        }
    }
    return parts.join("\n");
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

async function readBinaryFile(filePath, nm) {
    const ext = path.extname(filePath).toLowerCase().slice(1);
    switch (ext) {
        case "docx": return await readDocx(filePath, nm);
        case "xlsx": return await readXlsx(filePath, nm);
        case "pptx": return await readPptx(filePath, nm);
        case "doc": return `[.doc 是旧版 Word 格式，建议转换为 .docx 后再读取]`;
        case "xls": return `[.xls 是旧版 Excel 格式，建议转换为 .xlsx 后再读取]`;
        case "ppt": return `[.ppt 是旧版 PowerPoint 格式，建议转换为 .pptx 后再读取]`;
        case "zip": case "rar": case "7z": case "tar": case "gz": case "bz2":
            return await readZip(filePath, nm);
        case "odt": case "ods": case "odp":
            return await readZip(filePath, nm);
        case "mp3": case "wav": case "ogg": case "flac": case "aac": case "wma": case "m4a":
            return `[音频文件 .${ext}，无法转换为文本，文件路径: ${filePath}]`;
        case "mp4": case "avi": case "mkv": case "mov": case "wmv": case "flv": case "webm":
            return `[视频文件 .${ext}，无法转换为文本，文件路径: ${filePath}]`;
        case "jpg": case "jpeg": case "png": case "gif": case "bmp": case "svg": case "webp": case "ico":
            return `[图片文件 .${ext}，无法转换为文本，文件路径: ${filePath}]`;
        case "pdf":
            return `[PDF 文件，无法直接读取，文件路径: ${filePath}]`;
        default:
            return `[不支持的二进制文件类型: .${ext}，文件已保存，路径: ${filePath}]`;
    }
}

export default {
    id: SERVICE,
    setup: async (ctx) => {
        const nm = findNodeModules();
        const scripts = scriptsDir();

        const resolvePath = (filePath) => (path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath));

        await ctx.tool.transform((editor) => {
            editor.add({
                name: "read-binary",
                description: `读取二进制文件并将其转换为文本内容。支持的格式：.docx（Word 文档）、.xlsx（Excel 表格）、.pptx（PowerPoint 演示文稿）、.zip/.rar/.7z（压缩包，列出内容并展示可读文件）、.odt/.ods/.odp（OpenDocument 格式）。音频/视频/图片文件会返回文件路径信息。当 read 工具报错 "Cannot read binary file" 时，请使用此工具。`,
                input: {
                    type: "object",
                    properties: { filePath: { type: "string", description: "二进制文件的相对或绝对路径" } },
                    required: ["filePath"],
                },
                output: { type: "string" },
                execute: async (input) => {
                    const absPath = resolvePath(String(input?.filePath || ""));
                    if (!fs.existsSync(absPath)) return { output: `[文件不存在: ${absPath}]`, content: `[文件不存在: ${absPath}]` };
                    const stat = fs.statSync(absPath);
                    const ext = path.extname(absPath).toLowerCase().slice(1);
                    const typeName = EXT_NAMES[ext] || `.${ext}`;
                    try {
                        const text = await readBinaryFile(absPath, nm);
                        const header = `[${typeName}: ${path.basename(absPath)} | ${formatSize(stat.size)}]\n\n`;
                        const out = header + text;
                        return { output: out, content: out };
                    } catch (err) {
                        const out = `[读取 .${ext} 文件时出错: ${err?.message || err}]`;
                        return { output: out, content: out };
                    }
                },
            });

            editor.add({
                name: "write-binary",
                description: `修改二进制办公文档的内容和排版。支持 .docx（Word）和 .xlsx（Excel）。每次调用前会自动创建 .bak 备份。操作类型 replaceText/setStyle/addParagraph/insertParagraph/deleteParagraph/setCell/setCellStyle。`,
                input: {
                    type: "object",
                    properties: {
                        filePath: { type: "string", description: "要修改的文件绝对路径（仅支持 .docx 和 .xlsx）" },
                        operations: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    type: { type: "string", enum: ["replaceText", "setStyle", "addParagraph", "insertParagraph", "deleteParagraph", "setCell", "setCellStyle"] },
                                    params: { type: "object" },
                                },
                            },
                            description: "操作列表，按顺序执行",
                        },
                        backup: { type: "boolean", description: "是否创建 .bak 备份（默认 true）" },
                    },
                    required: ["filePath", "operations"],
                },
                output: { type: "string" },
                execute: async (input) => {
                    const absPath = resolvePath(String(input?.filePath || ""));
                    if (!fs.existsSync(absPath)) return { output: `[文件不存在: ${absPath}]`, content: `[文件不存在: ${absPath}]` };
                    const ext = path.extname(absPath).toLowerCase().slice(1);
                    if (!["docx", "xlsx"].includes(ext)) return { output: `[不支持的文件类型: .${ext}，目前只支持 .docx 和 .xlsx]`, content: `[不支持的文件类型: .${ext}]` };
                    const pyScript = path.join(scripts, "write-binary.py");
                    if (!fs.existsSync(pyScript)) return { output: `[缺少 write-binary.py 脚本: ${pyScript}]`, content: `[缺少 write-binary.py]` };
                    const cfg = { filePath: absPath, backup: input?.backup !== false, operations: input?.operations || [] };
                    const cfgPath = path.join(os.tmpdir(), `write-binary-${Date.now()}.json`);
                    await fs.promises.writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
                    const py = process.env.WULIANG_PYTHON || "python";
                    const out = await new Promise((resolve) => {
                        const proc = spawn(py, [pyScript, cfgPath], { windowsHide: true });
                        let stdout = "";
                        let stderr = "";
                        proc.stdout.on("data", (d) => { stdout += d.toString(); });
                        proc.stderr.on("data", (d) => { stderr += d.toString(); });
                        proc.on("close", () => {
                            fs.promises.unlink(cfgPath).catch(() => {});
                            try {
                                const result = JSON.parse(stdout.trim());
                                if (result.success) {
                                    const ops = (result.results || []).map(r => `${r.type}: ${r.success ? "OK" : "FAIL"} ${r.message || ""}`).join("\n");
                                    resolve(`[修改成功] 已保存到 ${absPath}\n操作结果:\n${ops}`);
                                } else {
                                    resolve(`[修改失败] ${result.message}`);
                                }
                            } catch {
                                resolve(`[write-binary 输出解析失败]\n${stdout}\n${stderr}`);
                            }
                        });
                    });
                    return { output: out, content: out };
                },
            });
        });

        try {
            await ctx.tool.hook("execute.before", async (event) => {
                if (event?.tool !== "read") return;
                const inp = event.input;
                if (!inp || typeof inp.path !== "string") return;
                const filePath = inp.path;
                const ext = path.extname(filePath).toLowerCase().slice(1);
                // 图片/PDF 交给 wuliang-image-vision 处理（它按模型能力决定直通或代理）
                if (VISION_HANDLED_EXTS.has(ext)) return;
                if (!BINARY_EXTS.has(ext)) return;
                const absPath = resolvePath(filePath);
                if (!fs.existsSync(absPath)) return;
                try {
                    const text = await readBinaryFile(absPath, nm);
                    const fileName = path.basename(filePath);
                    const typeName = EXT_NAMES[ext] || `.${ext}`;
                    const header = `[${typeName}: ${fileName} | ${formatSize(fs.statSync(absPath).size)}]\n\n`;
                    if (!fs.existsSync(TMP_DIR)) await fs.promises.mkdir(TMP_DIR, { recursive: true });
                    const tmpPath = path.join(TMP_DIR, `${fileName}.read-binary.txt`);
                    await fs.promises.writeFile(tmpPath, "\ufeff" + header + text, "utf-8");
                    event.input = { ...inp, path: tmpPath };
                } catch {}
            });
        } catch (err) {
            try { process.stdout.write(`[${SERVICE}] error execute.before hook: ${err?.message || err}\n`); } catch {}
        }

        try { process.stdout.write(`[${SERVICE}] loaded (node_modules=${nm || "none"})\n`); } catch {}
        return () => {};
    },
};
