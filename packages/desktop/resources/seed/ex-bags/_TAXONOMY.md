# ex-bags 标签词表（受控词表 TAXONOMY）

> 本文件定义 ex-bags 全部经验文档的 5 层标签。**新增文档必须从本词表取值，不得自造**。
> 设计原则：L1–L3 定位「这是什么」→ L4 定位「解决什么」→ L5 定位「能不能直接用」。

---

## 分层结构

| 层 | 名称 | 字段 | 作用 | 取值数 |
|---|---|---|---|---|
| L1 | 域 Domain | `domain` | 大领域，检索第一收敛点 | 10 |
| L2 | 主题 Subject | `subject` | 域内的知识块 | 35 |
| L3 | 技术栈 Stack | `stack` | 具体工具/语言/平台（可多值） | 45 |
| L4 | 问题型 Problem | `problem` | 问题类别，决定「怎么找」（可多值） | 12 |
| L5 | 结论等级 Level | `level` | 可直接照做 / 需前提 / 已排除 / 仅参考 | 4 |

**为什么是 5 层而不是 3 层**：3 层（域/栈/问题）无法表达「这条结论是否已被推翻」。AGENTS.md 明确要求「推翻已有结论前必须 grep 经验包，命中『❌ 已排除』禁止再试」——把它做成 L5 标签，就能用一次 grep 完成守卫，而不是靠人肉读全文。故第 5 层不是冗余，是**决策层**。

---

## L1 域 Domain（10）

| 值 | 含义 | 典型内容 |
|---|---|---|
| `SEC` | 安全与渗透 | 漏洞挖掘、众测提交、认证绕过、凭证泄露 |
| `CTF` | CTF 与答题平台 | pwn/web/crypto/misc、题库答题、自动填答 |
| `REV` | 逆向工程 | 内存修改、反编译、脱壳、协议还原 |
| `DEV` | 开发与构建 | Electron、前端工程、安卓打包、服务部署 |
| `OPS` | 系统与网络运维 | VPN、代理、路由、进程、端口、网络排障 |
| `AI` | AI 工具链 | 模型接入、上下文优化、视觉多模态、agent 架构 |
| `MOB` | 移动端 | 无障碍自动化、输入法灌字、读屏、签名 |
| `GAME` | 游戏与模组 | MC 整合包、Unity 移植、资源替换、游戏内机制 |
| `DOC` | 办公与文档 | Word/Excel/Visio、排版、实验报告 |
| `DATA` | 数据处理 | 编解码、压缩包、媒体转换、批量清洗 |

## L2 主题 Subject（42）

> 归属于 L1，用 `域/主题` 形式书写。

**SEC**
- `web渗透` — 目录扫描、参数探测、接口枚举
- `众测提交` — 平台流程、报告构造、审核规则
- `认证绕过` — 未授权访问、越权、会话绕过
- `凭证密钥` — 硬编码密钥、私钥泄露、token 提取
- `文件操作` — 上传、下载、路径穿越、存储桶
- `反爬对抗` — 限流、封禁、指纹、验证码

**CTF**
- `pwn` — 栈溢出、格式化字符串、GOT 覆写
- `web`
- `crypto`
- `misc` — 隐写、杂项、编码
- `流量分析` — pcap、协议还原
- `答题平台` — 智慧树、超星、题库类

**REV**
- `内存逆向` — Cheat Engine、内存搜索、指针链
- `反编译` — dnSpy、jadx、.NET/Mono
- `加固脱壳`
- `协议还原` — 抓包还原私有协议

**DEV**
- `Electron`
- `前端工程` — webpack、Vite、CSP、构建产物
- `安卓打包` — apk 重打包、签名、改名换图标
- `服务部署` — 服务器、端口、守护进程
- `脚本工程` — 通用脚本设计与复用

**OPS**
- `网络排障` — 路由、DNS、连通性
- `VPN代理` — OpenVPN、Clash、分流
- `进程端口` — 进程识别、杀进程、端口占用
- `存储文件` — 磁盘、备份、文件系统

**AI**
- `模型接入` — provider、API、订阅、鉴权
- `上下文优化` — token、压缩、缓存、检索
- `视觉多模态` — 图片/PDF 识别、视觉代理
- `agent架构` — 工具编排、子代理、会话隔离
- `提示词` — prompt 工程、交付格式

**MOB**
- `无障碍自动化` — AccessibilityService、自动点击填字
- `读屏输入法`
- `移动桥接` — 手机与 PC 通信、iLink

**GAME**
- `模组整合` — 整合包、Forge/Fabric、依赖冲突
- `游戏移植`
- `资源替换` — 贴图、模型、皮肤
- `游戏内机制` — 数值、存档、角色逻辑

**DOC / DATA**
- `文档排版` — Visio、Word、Excel
- `实验报告` — 课程实验、自动化截图
- `编解码` — base64/hex/加密算法
- `压缩包` — zip/rar/7z、加密破解
- `媒体转换` — 音视频、格式转换

## L3 技术栈 Stack（51）

> 具体到能被 grep 的名词。可多值。

**系统/运行时**
`Windows` `PowerShell` `Linux` `Android` `Firefox` `Chrome` `Electron` `Node` `Python` `Java` `CSharp`

**网络/协议**
`HTTP` `TLS` `WebSocket` `BiDi` `DNS` `OpenVPN` `Clash` `frp` `Wireshark` `Tcpdump`

**安全工具**
`ddddocr` `sqlmap` `BurpSuite` `openssl` `cryptography` `bkcrack` `adb` `apktool`

**AI/模型**
`opencode` `llama.cpp` `DeepSeek` `豆包` `ONNX` `MCP`

**平台/框架**
`Vue` `React` `SpringBoot` `Unity` `Minecraft` `Forge` `UEditor` `AntDesign`

**其他**
`DOSBox` `DEBUG` `PacketTracer` `Visio` `Excel` `FFmpeg` `S3` `OSS`

## L4 问题型 Problem（12）

| 值 | 含义 | 检索意图 |
|---|---|---|
| `ENV` | 环境配置与安装 | 「怎么装/怎么配」 |
| `ERR` | 报错排查 | 「XX 报错怎么办」 |
| `AUTH` | 认证与权限 | 「怎么绕过/怎么校验」 |
| `CRYPTO` | 加密解密与签名 | 「怎么解/怎么签」 |
| `EXTRACT` | 数据提取与解析 | 「怎么从 X 里取出 Y」 |
| `INJECT` | 写入与注入 | 「怎么把 X 写进去」 |
| `AUTOMATE` | 批量自动化 | 「怎么一次做完」 |
| `PROTO` | 协议与抓包 | 「这个请求怎么构」 |
| `PERF` | 性能与资源 | 「慢/占用高」 |
| `RECOVER` | 恢复与备份 | 「坏了怎么救」 |
| `LIMIT` | 限流与封禁规避 | 「被限速/被封」 |
| `INCOMPAT` | 兼容与冲突 | 「版本不匹配/互相打架」 |

## L5 结论等级 Level（4）

| 值 | 标记 | 含义 | 使用约束 |
|---|---|---|---|
| `VERIFIED` | ✅ | 实测通过，可照做 | 默认首选 |
| `PARTIAL` | ⚠️ | 有前提/部分可行 | 必须读「前提」再动手 |
| `EXCLUDED` | ❌ | **已验证排除，禁止重试** | 命中即停止该方向 |
| `REF` | 📋 | 纯参考资料，无操作结论 | 不作为依据 |

---

## 文档头部格式

```yaml
---
id: SEC-003
domain: SEC
subject: 众测提交
stack: [HTTP, Firefox, ddddocr]
problem: [AUTH, AUTOMATE]
level: VERIFIED
keywords: [雷神众测, bountyteam, 验证码, submitBug, 白名单]
related: [SEC-001, AI-002]
updated: 2026-10-21
---
```

**字段规则**
- `id`：`<L1>-<三位序号>`，全库唯一
- `keywords`：项目名、平台名、别名、旧文件名——**长尾专有名词只放这里，不进分层**
- `related`：强相关文档 id
- `updated`：最后实质修改日期

## 正文结构（去项目化）

```markdown
# 知识点标题（写「怎么做」，不写「某项目记录」）

> **适用**：一句话场景
> **前置**：需要的环境/权限/账号

## 结论
3 行内说清结论与做法。

## 步骤
1. ...

## 坑
- ❌ 具体错误做法 → 正解

## 验证
如何确认成功（可执行的判据，不是「看起来对」）

## 案例
项目专属细节全部压到这里，且只在必要时保留。
```

**硬约束**
- 「结论/步骤/坑/验证」四节不得出现具体项目名、域名、编号
- 项目细节一律下沉到 `## 案例`
- 已排除项必须以 `❌` 开头，便于 grep

## 检索约定

| 想找什么 | 查法 |
|---|---|
| 某领域的全部经验 | `grep "^domain: SEC"` |
| 某个技术栈 | `grep "PowerShell"` |
| 某类问题（如被封） | `grep "^problem:.*LIMIT"` |
| **别再试什么** | `grep "level: EXCLUDED"` |
| 某项目相关 | `grep "keywords:.*招商"` |

自动化检索：`wuliang-ctx-memory.js` 插件按 BM25 自动注入 topK=3 片段；本词表标签作为正文 token 参与打分，故新文档必须保留头部块。

## 目录结构（实际布局）

`
E:\AIoutput\ex-bags\
  _TAXONOMY.md      # 本词表（不参与检索）
  _INDEX.md         # 全库标签速查表（不参与检索）
  _state/           # 交接与归档，不参与检索
    TASK_STATE.md
    superseded/     # 已被拆分替代的旧文档
  SEC/  CTF/  REV/  DEV/  OPS/  AI/  MOB/  GAME/  DOC/  DATA/
`

**检索范围**：插件递归扫描全部子目录，但**跳过以 _ 或 . 开头的目录/文件**，因此 _state/、_INDEX.md、_backup_* 不会污染检索结果。
