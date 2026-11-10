import { describe, expect, test } from "bun:test"
import { classify } from "@opencode/core/plugin/compaction-index"

// Every case here is a real summary shape that produced a wrong answer in a shipped build,
// not an invented one. The first four are the false positives that motivated the rewrite:
// a session about the kernel itself activated four unrelated domains.

describe("classify", () => {
  test("work on the preference feature does not activate every domain", () => {
    // Naming the domains is not doing the work. This is the self-reference case: the
    // summary describes the tag list, so a raw keyword pass matches all of it.
    const summary = [
      "## Objective",
      "- 任务域先定这些：`ctf` `bounty` `packaging` `report` `image` `answer` `android` `proxy`",
      "- 偏好池按任务域打标签，压缩后自动切换",
    ].join("\n")
    expect(classify(summary)).toEqual([])
  })

  test("paths are not subject matter", () => {
    // `src` in `packages/core/src/` is a directory, not a security response centre.
    const summary = [
      "## Objective",
      "- 新建 `packages/core/src/plugin/compaction-index.ts`，订阅 session.compaction.ended",
      "- `packages/core/src/tool/plugin/preference.ts` 新增 preference 工具",
    ].join("\n")
    expect(classify(summary)).not.toContain("bounty")
  })

  test("a Unicode surrogate pair is not a proxy server", () => {
    const summary = "- 必要时用 preference add 重建全部 30 条而非 SQL 直写，注意非法 UTF-8 代理对"
    expect(classify(summary)).not.toContain("proxy")
  })

  test("image off-loading is not image work", () => {
    const summary = "- 上下文外置已生效，实测 158/159 落盘（图片外置后按路径引用）"
    expect(classify(summary)).not.toContain("image")
  })

  test("a packaging session is classified as packaging only", () => {
    const summary = [
      "## Objective",
      "- 重新打一个干净安装包并上传",
      "- 用 electron-builder --prepackaged 跳过工具链下载，asar 重建后核对版本号",
      "- 出包前检查依赖目录",
    ].join("\n")
    expect(classify(summary)).toEqual(["packaging"])
  })

  test("stored segment headers are ignored", () => {
    // A stored segment repeats its own domain line. Counting that as evidence would make
    // every segment confirm whatever it was first labelled with.
    const summary = ["# b3  Objective", "", "- 边界: kernel", "- 域: ctf, proxy", "", "## Objective", "- 修打包流程"].join("\n")
    expect(classify(summary)).toEqual(["packaging"])
  })

  test("real ctf work is still detected", () => {
    expect(classify("- 拿到 flag{test_flag}，提交到靶场")).toContain("ctf")
    expect(classify("- 用 bkcrack 对 ZipCrypto 做已知明文攻击")).toContain("ctf")
  })

  test("real bounty work is still detected", () => {
    expect(classify("- 雷神众测提交漏洞报告，附可视化截图证据")).toContain("bounty")
  })

  test("real proxy work is still detected", () => {
    expect(classify("- 7890 端口不通，clash 节点全部 reset，改用 socks5")).toContain("proxy")
    expect(classify("- 代理软件的 TUN 模式接管了全局路由")).toContain("proxy")
  })

  test("real android work is still detected", () => {
    expect(classify("- 用 adb 装机，apk 重打包后签名")).toContain("android")
  })

  test("real image work is still detected", () => {
    expect(classify("- 生成像素立绘，用纯色幕布抠像后放入项目")).toContain("image")
  })

  test("one weak word is not enough on its own", () => {
    // `截图` shows up in a report as a deliverable and in a browser rule as evidence
    // collection. One occurrence says an artefact exists, not that this is that kind of work.
    expect(classify("- 提交时附一张截图")).not.toContain("image")
    expect(classify("- 报告里附上截图和运行结果")).not.toContain("image")
  })

  test("documentation work is detected without a docx", () => {
    expect(classify("- 写实验报告，插入截图，排版")).toContain("report")
  })
})
