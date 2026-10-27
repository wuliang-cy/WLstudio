// packages/core/test/context-budget.test.ts
//
// 上下文预算插件单测。放置位置和写法参考同目录已有的 session-runner.test.ts。
// 只测纯函数 transformRequest，不启动服务，跑得很快。

import { describe, expect, test } from "bun:test"
import { transformRequest } from "../src/plugin/context-budget.js"

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/** 造一个能被去重的 data URL：尾巴加 tag 让 base64 不同（内容仍是合法 PNG 前缀）。 */
const dataUrl = (tag = "") => "data:image/png;base64," + TINY_PNG + tag

const imageToolResult = (id: string, tag = "") => ({
  role: "assistant" as const,
  content: [
    {
      type: "tool-result" as const,
      id,
      name: "read",
      result: {
        type: "content" as const,
        value: [
          { type: "text" as const, text: "Image read successfully" },
          { type: "file" as const, uri: dataUrl(tag), mime: "image/png", name: "x.png" },
        ],
      },
    },
  ],
})

const userMessage = (text: string) => ({
  role: "user" as const,
  content: [{ type: "text" as const, text }],
})

const countImages = (messages: any[]) => (JSON.stringify(messages).match(/data:image/g) ?? []).length

describe("context-budget", () => {
  test("历史图片被外置并留路径说明", () => {
    const messages: any[] = [
      userMessage("看图"),
      imageToolResult("h1"),
      userMessage("继续"),
    ]
    const stats = transformRequest(messages as any)
    expect(stats.images).toBe(1)
    expect(countImages(messages)).toBe(0)
    const text = JSON.stringify(messages[1])
    expect(text).toContain("图片已外置")
    // 落盘路径必须真实存在
    const match = /img_[0-9a-z]+\.png/.exec(text)
    expect(match).not.toBeNull()
  })

  test("当前轮 0 张图：不改动", () => {
    const messages: any[] = [userMessage("开始"), imageToolResult("h1"), userMessage("继续")]
    transformRequest(messages as any)
    const before = JSON.stringify(messages)
    const stats = transformRequest(messages as any)
    expect(stats.images).toBe(0)
    expect(JSON.stringify(messages)).toBe(before)
  })

  test("当前轮 1 张图：保留", () => {
    const messages: any[] = [userMessage("开始"), userMessage("继续"), imageToolResult("c1")]
    transformRequest(messages as any)
    expect(countImages(messages)).toBe(1)
  })

  test("当前轮 2 张图：都保留", () => {
    const messages: any[] = [
      userMessage("开始"),
      userMessage("继续"),
      imageToolResult("c1", "AAAA"),
      imageToolResult("c2", "BBBB"),
    ]
    transformRequest(messages as any)
    expect(countImages(messages)).toBe(2)
  })

  test("当前轮 3 张图：只留最新 2 张", () => {
    const messages: any[] = [
      userMessage("开始"),
      userMessage("继续"),
      imageToolResult("c1", "AAAA"),
      imageToolResult("c2", "BBBB"),
      imageToolResult("c3", "CCCC"),
    ]
    const stats = transformRequest(messages as any)
    expect(countImages(messages)).toBe(2)
    expect(stats.images).toBe(1)
    // 第 1 张被外置，第 2、3 张保留
    expect(JSON.stringify(messages[2])).toContain("图片已外置")
    expect(JSON.stringify(messages[3])).toContain("data:image")
    expect(JSON.stringify(messages[4])).toContain("data:image")
  })

  test("当前轮 10 张图：仍只留最新 2 张", () => {
    const messages: any[] = [userMessage("开始"), userMessage("继续")]
    for (let i = 0; i < 10; i++) messages.push(imageToolResult("c" + i, "A".repeat(i * 4)))
    const stats = transformRequest(messages as any)
    expect(countImages(messages)).toBe(2)
    expect(stats.images).toBe(8)
  })

  test("超长文本被裁剪并落盘", () => {
    const big = "x".repeat(20000)
    const messages: any[] = [
      userMessage("开始"),
      {
        role: "assistant" as const,
        content: [
          {
            type: "tool-result" as const,
            id: "t1",
            name: "shell",
            result: { type: "content" as const, value: [{ type: "text" as const, text: big }] },
          },
        ],
      },
      userMessage("继续"),
    ]
    const before = JSON.stringify(messages).length
    const stats = transformRequest(messages as any)
    const after = JSON.stringify(messages).length
    expect(stats.trimmed).toBeGreaterThan(0)
    expect(after).toBeLessThan(before)
    expect(JSON.stringify(messages)).toContain("已省略中间")
  })

  test("没有 user 消息时不改动（compaction 请求）", () => {
    const messages: any[] = [imageToolResult("h1")]
    const before = JSON.stringify(messages)
    const stats = transformRequest(messages as any)
    expect(stats.images).toBe(0)
    expect(JSON.stringify(messages)).toBe(before)
  })
})
