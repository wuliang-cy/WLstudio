import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";

const SERVICE = "wuliang-image-vision";
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]);
const PDF_EXTENSIONS = new Set([".pdf"]);
const EXT_TO_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
};
const VISION_MODEL_PATTERNS = [
    /\bgpt[\-_]?4o\b/i, /\bgpt[\-_]?4[\-_]?turbo\b/i, /\bgpt[\-_]?4[\-_]?vision\b/i,
    /\bgpt[\-_]?5/i, /\bo[1-4]\b/i, /\bclaude[\-_]?3[\-_]?5[\-_]?sonnet\b/i,
    /\bclaude[\-_]?3[\-_]?opus\b/i, /\bclaude[\-_]?(4|opus[\-_]?4|sonnet[\-_]?4)/i,
    /\bclaude[\-_]?sonnet[\-_]?4/i, /\bclaude[\-_]?opus[\-_]?4/i, /\bclaude[\-_]?4[\-_]?5/i,
    /\bgemini[\-_]?2/i, /\bgemini[\-_]?3/i, /\bqwen[\-_]?vl\b/i, /\bllava\b/i,
    /\bgemma[\-_]?3/i, /\binternvl\b/i, /\bcogvlm\b/i, /\bmini[\-_]?cpm[\-_]?v\b/i,
    /\bphi[\-_]?3[\-_]?vision\b/i,
];
const TMP_DIR = path.join(os.tmpdir(), "opencode-image-vision");
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_LANGUAGE = "zh";
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_PDF_SIZE = 50 * 1024 * 1024;
const VISION_API_TIMEOUT = 60_000;

const VISION_CONFIG = {
    provider: "custom",
    model: "deepseek-flash",
    // Never ship a key: this file is copied to every install. Read it from the environment or the
    // kernel config instead, and let the vision path report "unconfigured" when neither is present.
    apiKey: "",
    apiKeyEnv: "WLSTUDIO_VISION_API_KEY",
    baseUrl: "https://api.deepseek.com",
    language: "zh",
    skipModels: ["ark-code-latest", "doubao-seed-code", "doubao-seed-2.0-code", "doubao-seed-2.0-pro", "doubao-seed-2.0-lite", "kimi-k2.6", "kimi-k2.5", "deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"],
};

const PDF_RENDER_PYTHON = process.env.WULIANG_PYTHON || "python";
const PDF_RENDER_DPI = Number(process.env.WULIANG_PDF_DPI || 150);
const PDF_RENDER_MAX_PAGES = Number(process.env.WULIANG_PDF_MAX_PAGES || 40);

const PDF_RENDER_SCRIPT = [
    "import sys, os",
    "import fitz",
    "src, outdir, dpi, maxp = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])",
    "os.makedirs(outdir, exist_ok=True)",
    "doc = fitz.open(src)",
    "n = min(doc.page_count, maxp)",
    "out = []",
    "for i in range(n):",
    "    pix = doc[i].get_pixmap(dpi=dpi)",
    "    p = os.path.join(outdir, 'page-%02d.png' % (i + 1))",
    "    pix.save(p)",
    "    out.append(p)",
    "print('\\n'.join(out))",
].join("\n");

function log(level, message) {
    try { process.stdout.write(`[${SERVICE}] ${level} ${message}\n`); } catch {}
}

function isImagePath(filePath) { return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()); }
function isPdfPath(filePath) { return PDF_EXTENSIONS.has(path.extname(filePath).toLowerCase()); }
function mimeTypeFromExt(filePath) { return EXT_TO_MIME[path.extname(filePath).toLowerCase()] ?? "image/png"; }
function getApiKey(config) { return config.apiKey || (config.apiKeyEnv ? process.env[config.apiKeyEnv] || "" : ""); }
function getBaseUrl(config) { return (config.baseUrl || "").replace(/\/$/, ""); }

function buildVisionPrompt(config, userPrompt, isPdf) {
    if (userPrompt) return userPrompt;
    const lang = config.language || DEFAULT_LANGUAGE;
    if (isPdf) {
        return `Please analyze this PDF document in detail in ${lang === "zh" ? "Chinese" : "English"}. Include: document structure, key content, text transcription, tables (if any), charts/diagrams descriptions, and summary of main points. If the PDF contains code or formulas, transcribe them accurately.`;
    }
    return `Please describe this image in detail in ${lang === "zh" ? "Chinese" : "English"}. Include: visual content, layout, text content (if any), colors, and any notable details. If the image contains code or error messages, transcribe them accurately.`;
}

async function ensureDir(dir) { if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true }); }

async function openaiVisionDescribe(config, base64, mime, prompt) {
    const url = `${getBaseUrl(config)}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VISION_API_TIMEOUT);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${getApiKey(config) || "unused"}` },
            body: JSON.stringify({
                model: config.model,
                max_tokens: config.maxTokens || DEFAULT_MAX_TOKENS,
                messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } }, { type: "text", text: prompt }] }],
            }),
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`Vision API error: ${response.status} ${await response.text()}`);
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || "[No description returned]";
    } finally { clearTimeout(timer); }
}

async function describeImage(config, base64, mime, userPrompt) {
    const prompt = buildVisionPrompt(config, userPrompt, mime === "application/pdf");
    return openaiVisionDescribe(config, base64, mime, prompt);
}

function renderPdfToPngs(absPath) {
    const stat = fs.statSync(absPath);
    const base = path.basename(absPath, path.extname(absPath));
    const outDir = path.join(TMP_DIR, "pdf-pages", `${base}-${Math.round(stat.mtimeMs)}`);
    const out = execFileSync(
        PDF_RENDER_PYTHON,
        ["-c", PDF_RENDER_SCRIPT, absPath, outDir, String(PDF_RENDER_DPI), String(PDF_RENDER_MAX_PAGES)],
        { encoding: "utf-8", timeout: 180000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

async function writePdfPageManifest(absPath, pngs) {
    await ensureDir(TMP_DIR);
    const txtPath = path.join(TMP_DIR, `${path.basename(absPath, path.extname(absPath))}.pages.txt`);
    const lines = [
        `[${SERVICE}] 当前模型不支持直接读取 PDF，已在本机把 PDF 渲染为 ${pngs.length} 张 PNG 页面图片。`,
        `源文件: ${absPath}`,
        `渲染页码: ${pngs.length}（最多 ${PDF_RENDER_MAX_PAGES} 页，dpi=${PDF_RENDER_DPI}）`,
        "",
        "请用 read 工具读取下列 PNG 文件（支持一次发起多个 read 调用并行读取）：",
        ...pngs.map(p => `- ${p}`),
    ];
    await fs.promises.writeFile(txtPath, lines.join("\n"), "utf-8");
    return txtPath;
}

async function writeTempDescription(originalPath, description, config) {
    await ensureDir(TMP_DIR);
    const tmpPath = path.join(TMP_DIR, `${path.basename(originalPath, path.extname(originalPath))}.vision.txt`);
    await fs.promises.writeFile(tmpPath, "\ufeff" + [
        `[${SERVICE}]`,
        `Source: ${originalPath}`,
        `Vision Model: ${config.provider}/${config.model}`,
        "", description,
    ].join("\n"), "utf-8");
    return tmpPath;
}

async function processImage(absPath, config, userPrompt) {
    if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
    const stat = await fs.promises.stat(absPath);
    const isPdf = isPdfPath(absPath);
    if (stat.size > (isPdf ? MAX_PDF_SIZE : MAX_IMAGE_SIZE)) throw new Error(`File too large`);
    const buf = await fs.promises.readFile(absPath);
    if (isPdf) {
        try {
            const pngs = renderPdfToPngs(absPath);
            if (pngs.length) {
                const parts = [];
                for (const png of pngs) {
                    const b64 = (await fs.promises.readFile(png)).toString("base64");
                    const desc = await describeImage(config, b64, "image/png", userPrompt ? `${userPrompt}\n(${path.basename(png)})` : undefined);
                    parts.push(`## ${path.basename(png)}\n${desc}`);
                }
                return { description: parts.join("\n\n") };
            }
        } catch (err) {
            log("error", `pdf render failed: ${err?.message || err}`);
        }
    }
    const description = await describeImage(config, buf.toString("base64"), mimeTypeFromExt(absPath), userPrompt);
    return { description };
}

function modelSupportsVisionPattern(modelId) { return VISION_MODEL_PATTERNS.some(p => p.test((modelId || "").toLowerCase())); }

function readJsonc(file) {
    try {
        if (!fs.existsSync(file)) return null;
        const raw = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
        const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(stripped);
    } catch { return null; }
}

function configCandidates() {
    const home = os.homedir();
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
    const dirs = [path.join(xdg, "wlstudio"), process.cwd()];
    const files = [];
    for (const d of dirs) {
        files.push(path.join(d, "opencode.json"), path.join(d, "opencode.jsonc"));
    }
    return files;
}

function capsFromDisk(modelRef) {
    const modelStr = `${modelRef?.providerID || ""}/${modelRef?.id || ""}`;
    for (const file of configCandidates()) {
        const cfg = readJsonc(file);
        if (!cfg) continue;
        const modelCfg = cfg?.providers?.[modelRef?.providerID]?.models?.[modelRef?.id];
        if (modelCfg) {
            const inputs = Array.isArray(modelCfg?.capabilities?.input) ? modelCfg.capabilities.input : [];
            return { id: modelStr, image: inputs.includes("image"), pdf: inputs.includes("pdf") };
        }
    }
    return null;
}

function resolveCaps(modelRef, config) {
    const modelStr = `${modelRef?.providerID || ""}/${modelRef?.id || ""}`;
    const fromDisk = capsFromDisk(modelRef);
    if (fromDisk && (fromDisk.image || fromDisk.pdf)) return fromDisk;
    let image = fromDisk?.image ?? false;
    const pdf = fromDisk?.pdf ?? false;
    if (!image && config?.skipModels?.length) {
        const lower = modelStr.toLowerCase();
        if (config.skipModels.map(m => m.toLowerCase()).some(m => m && lower.includes(m))) image = true;
    }
    if (!image && modelSupportsVisionPattern(modelStr)) image = true;
    return { id: modelStr, image, pdf };
}

export default {
    id: "wuliang-image-vision",
    setup: async (ctx) => {
        const config = VISION_CONFIG;
        const sessionModels = new Map();
        await ensureDir(TMP_DIR);

        try {
            await ctx.session.hook("context", (event) => {
                if (event?.model && event?.sessionID) sessionModels.set(event.sessionID, event.model);
            });
        } catch (err) { log("error", `context hook failed: ${err?.message || err}`); }

        const resolve = (sessionID) => resolveCaps(sessionModels.get(sessionID), config);

        try {
            await ctx.tool.transform((editor) => {
                editor.add({
                    name: "read-image",
                    description: "读取图片或 PDF 文件并返回文字描述。若当前模型本身支持原生视觉（如多模态模型），图片会被提示改用 read 直接读取、PDF 会在本机渲染为 PNG 后再用 read 读取，均不会调用视觉代理；仅当当前模型不支持视觉时才调用视觉代理。",
                    input: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "图片或 PDF 文件的相对或绝对路径" },
                            prompt: { type: "string", description: "可选提示词，引导视觉模型关注特定方面" },
                        },
                        required: ["path"],
                    },
                    output: { type: "string" },
                    execute: async (input, toolCtx) => {
                        const raw = String(input?.path || "");
                        const absPath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
                        if (!fs.existsSync(absPath)) throw new Error(`File not found: ${absPath}`);
                        const caps = resolve(toolCtx?.sessionID);
                        if (isImagePath(absPath) && caps.image) {
                            const msg = `当前模型（${caps.id || "unknown"}）支持原生视觉，无需视觉代理。请直接使用 read 工具读取图片：\n${absPath}`;
                            return { output: msg, content: msg, metadata: { nativeVision: true, proxyUsed: false, path: absPath } };
                        }
                        if (isPdfPath(absPath) && caps.pdf) {
                            const msg = `当前模型（${caps.id || "unknown"}）可直接读取 PDF，无需视觉代理。请直接使用 read 工具读取：\n${absPath}`;
                            return { output: msg, content: msg, metadata: { nativeVision: true, proxyUsed: false, path: absPath } };
                        }
                        if (isPdfPath(absPath) && caps.image) {
                            try {
                                const pngs = renderPdfToPngs(absPath);
                                if (pngs.length) {
                                    const manifest = await writePdfPageManifest(absPath, pngs);
                                    const msg = `当前模型（${caps.id || "unknown"}）支持原生视觉但不支持直接读取 PDF，已在本机把 PDF 渲染为 ${pngs.length} 张 PNG，未调用视觉代理。请用 read 工具逐页读取（可一次发起多个 read 调用）：\n${pngs.map(p => `- ${p}`).join("\n")}\n\n清单文件：${manifest}`;
                                    return { output: msg, content: msg, metadata: { nativeVision: true, proxyUsed: false, pages: pngs.length, files: pngs } };
                                }
                            } catch (err) { log("error", `read-image pdf render failed: ${err?.message || err}`); }
                        }
                        const { description } = await processImage(absPath, config, input?.prompt);
                        return { output: description, content: description, metadata: { nativeVision: false, proxyUsed: true } };
                    },
                });
            });
        } catch (err) { log("error", `tool.transform failed: ${err?.message || err}`); }

        try {
            await ctx.tool.hook("execute.before", async (event) => {
                if (event?.tool !== "read") return;
                const inp = event.input;
                if (!inp || typeof inp.path !== "string") return;
                const filePath = inp.path;
                if (!isImagePath(filePath) && !isPdfPath(filePath)) return;
                const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
                const caps = resolve(event.sessionID);
                if (isImagePath(absPath) && caps.image) return;
                if (isPdfPath(absPath) && caps.pdf) return;
                if (isPdfPath(absPath) && caps.image) {
                    try {
                        const pngs = renderPdfToPngs(absPath);
                        if (pngs.length) {
                            event.input = { ...inp, path: await writePdfPageManifest(absPath, pngs) };
                            return;
                        }
                    } catch (err) { log("error", `pdf render failed: ${err?.message || err}`); }
                }
                if (!fs.existsSync(absPath)) return;
                const { description } = await processImage(absPath, config);
                event.input = { ...inp, path: await writeTempDescription(absPath, description, config) };
            });
        } catch (err) { log("error", `execute.before hook failed: ${err?.message || err}`); }

        log("info", `Vision initialized: provider=${config.provider}, model=${config.model}`);
        return () => {};
    },
};
