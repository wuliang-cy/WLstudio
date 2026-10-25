import { analyze, crack, decrypt, reset } from "./lib/zipcrack.js";

export default {
  id: "wuliang-zip-parse",
  setup: async (ctx) => {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "zip_analyze",
        description:
          "分析 ZIP 压缩包结构：解析 zip 条目、列出全部条目、加密方式(ZipCrypto/AES)、压缩方式、data descriptor、目录牵引；并自动推荐可用于 ZipCrypto 已知明文攻击的条目(如PNG/MP4)及其偏移。当需要破解加密 ZIP 或了解 ZIP 内部结构时使用。",
        input: {
          type: "object",
          properties: { zipPath: { type: "string", description: "ZIP 文件路径" } },
          required: ["zipPath"],
        },
        output: { type: "string" },
        execute: async (input) => {
          try {
            const out = JSON.stringify(analyze(String(input?.zipPath || "")), null, 2);
            return { output: out, content: out };
          } catch (e) {
            const out = "ERROR: " + (e?.message || e);
            return { output: out, content: out };
          }
        },
      });

      editor.add({
        name: "zip_crack",
        description:
          "对 ZipCrypto 加密的 ZIP 执行已知明文攻击(bkcrack 封装内置)。需提供已知明文的 hex 与偏移。注意：偏移量是相对压缩数据(不含加密头)，PNG 存储块头常见偏移为 5。成功后返回内部密钥 [X,Y,Z] 及密钥文件。",
        input: {
          type: "object",
          properties: {
            zipPath: { type: "string", description: "ZIP 文件路径" },
            known: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  offset: { type: "number", description: "已知明文相对压缩数据的偏移(不含加密头)" },
                  hex: { type: "string", description: "已知明文十六进制，如 89504E470D0A1A0A0000000D49484452" },
                },
                required: ["offset", "hex"],
              },
              description: "已知明文列表(可传一条，可多次覆盖)",
            },
            cipherIndex: { type: "number", description: "目标条目的索引(来自 zip_analyze)，默认自动选择第一个加密条目" },
          },
          required: ["zipPath", "known"],
        },
        output: { type: "string" },
        execute: async (input) => {
          try {
            const out = JSON.stringify(crack(input), null, 2);
            return { output: out, content: out };
          } catch (e) {
            const out = "ERROR: " + (e?.message || e);
            return { output: out, content: out };
          }
        },
      });

      editor.add({
        name: "zip_decrypt",
        description:
          "使用已恢复的 ZipCrypto 密钥 [X,Y,Z] 解密 ZIP 条目、解压(deflate)、重建目录与条目校验(CRC)，输出目录默认为 ZIP 同目录下的「原文件名_解密」文件夹。",
        input: {
          type: "object",
          properties: {
            zipPath: { type: "string", description: "ZIP 文件路径" },
            keys: { type: "array", items: { type: "string" }, description: "3 个 32 位密钥 hex，如 ['5d039ff9','1ba24e49','adfeaa09']" },
            outDir: { type: "string", description: "输出目录，默认 ZIP 同目录下 原文件名_解密" },
            cipherIndexes: { type: "array", items: { type: "number" }, description: "只解密指定条目索引，默认全部条目" },
          },
          required: ["zipPath", "keys"],
        },
        output: { type: "string" },
        execute: async (input) => {
          try {
            const out = JSON.stringify(decrypt(input), null, 2);
            return { output: out, content: out };
          } catch (e) {
            const out = "ERROR: " + (e?.message || e);
            return { output: out, content: out };
          }
        },
      });

      editor.add({
        name: "zip_reset",
        description:
          "用已恢复的 ZipCrypto 密钥 [X,Y,Z] 把加密 ZIP 改为已知密码(空密码、bkcrack -U)，输出到原目录、文件名为「原文件名（无密码）.zip」，可直接用 Bandizip/WinRAR 打开或重新压缩。",
        input: {
          type: "object",
          properties: {
            zipPath: { type: "string", description: "ZIP 文件路径" },
            keys: { type: "array", items: { type: "string" }, description: "3 个 32 位密钥 hex，如 ['5d039ff9','1ba24e49','adfeaa09']" },
            newPassword: { type: "string", description: "新的解压密码" },
          },
          required: ["zipPath", "keys", "newPassword"],
        },
        output: { type: "string" },
        execute: async (input) => {
          try {
            const out = JSON.stringify(reset(input), null, 2);
            return { output: out, content: out };
          } catch (e) {
            const out = "ERROR: " + (e?.message || e);
            return { output: out, content: out };
          }
        },
      });
    });
    return () => {};
  },
};
