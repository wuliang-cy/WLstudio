# WLstudio · 无量工作台

> 一个把「AI 编程助手」做成**能长期积累、跨会话延续、真正会动手**的桌面工作台。
>
> 基于 [opencode](https://github.com/anomalyco/opencode)（MIT）二次开发，保留其内核能力，重做分发、偏好、经验积累与浏览器控制四层。

---

## 为什么要做这个

上游 opencode 是一个优秀的开源 AI 编程 agent。但把它当作**日常主力工具**长期使用时，会遇到几个它没有正面解决的问题：

| 问题 | 表现 |
|---|---|
| **上下文越用越贵** | 每轮全量重发历史，图片与大工具输出常驻，聊得越久单轮成本越高 |
| **经验不积累** | 这次踩的坑，下次换个会话又从零开始；总结写了但下次不会自动用上 |
| **偏好无法区分** | 通用规则和「我这台机器的路径/代理/工具位置」混在一起，换设备就废，共享给别人又泄露隐私 |
| **AI 只能读不能看** | 需要一个真正能被控制的浏览器：打开页面、点按钮、读内容，而不是靠 HTTP 猜测 |
| **分发即灾难** | 打包出去的版本里混着作者的路径、密钥、开发目录；用户装完首启就报文件找不到 |

WLstudio 就是针对这五点做的工程化改造。

---

## 核心特性

### 一、经验树（ex-bags）

不是「写一堆 md 文件」，而是**一套能被检索、能被守卫、能自我纠错的知识库**。

#### 5 层标签，让检索和防重犯同时成立

每篇经验文档开头必须是受控 frontmatter：

| 层 | 字段 | 作用 | 取值 |
|---|---|---|---|
| L1 | `domain` | 大领域，检索第一收敛点 | 10 |
| L2 | `subject` | 域内知识块 | 35 |
| L3 | `stack` | 具体工具/语言/平台（可多值） | 45 |
| L4 | `problem` | 问题类别，决定「怎么找」（可多值） | 12 |
| L5 | `level` | **结论等级**：`VERIFIED` / `PARTIAL` / `EXCLUDED` / `REF` | 4 |

为什么不是 3 层就够？因为三层（域→主题→问题）无法表达**「这条结论是否已经被推翻」**。

真实场景：某个 exploit 思路试过、失败了，写进经验并标 `level: EXCLUDED`。下次再遇到同类问题，一条 `grep "level: EXCLUDED"` 就能拦住——**而不是让 AI 把已经否掉的错路当假设再试一遍**。

这不是理论。这个功能就是因为一次真实事故加的：一个已验证的结论在压缩摘要里丢了可执行步骤，AI 把它当"待验证假设"重新试错，连续失败十几次、烧掉数十轮工具调用。

#### 10 个域目录

`SEC` `CTF` `REV` `DEV` `OPS` `AI` `MOB` `GAME` `DOC` `DATA`

配 `_TAXONOMY.md`（受控词表，禁止自造标签）、`_INDEX.md`（全库速查）、`_state/TASK_STATE.md`（跨会话任务交接）。

#### 自动检索注入

不是靠 AI "记得去查"，而是内核插件在**每次用户发消息时**自动做 BM25 检索：

- 纯关键词 BM25，top-3 片段，最多 1500 字符
- 双重阈值（原始分数 ≥ 2.0、命中实体词 ≥ 2），防漏召也防拉满
- 注入位置是**当前用户消息尾部**，不是 system —— 见下一节的缓存考量

#### 落点可移植

经验库位置**不写死**，按优先级解析：

```
WLSTUDIO_EX_BAGS  →  WLSTUDIO_DATA/ex-bags  →  <安装目录>/../WLstudio-data/ex-bags
```

安装时由安装器把数据根写到所选安装盘（`<盘>:\WLstudio-data`），换设备自动重算。目的很实际：**经验库会随使用无限增长，不能塞在 C 盘用户目录里**。

---

### 二、两层偏好 + 启动预热

把「该共享的」和「不该共享的」在文件层面就切开。

#### 第一层：基础偏好 `AGENTS.md`（可分发）

通用、稳定、跨设备成立的规则：文件输出约定、工程组织方式、任务推进纪律、代码风格。

**关键设计：随安装包分发，但用占位符写路径。**

```markdown
- **基础偏好设置**: `__WLSTUDIO_WORKSPACE__\AGENTS.md`
- **经验库**: `__WLSTUDIO_EXBAGS__\`
- **数据库**: `__WLSTUDIO_DBDIR__\wlstudio.db`
```

首次启动时由桌面壳把这些占位符渲染成**当前机器的真实路径**，并且在**每次启动**都做一次路径自愈（只替换已知 token，有变更才写，写前存 `.bak-paths`）。所以从 C 盘重装到 E 盘，文档里的路径会自动修正，不需要重新出包。

> 这里踩过一个大坑：早期版本直接把作者的开发路径硬编码进去，装到别的机器上首启就报 `File not found`。更糟的是「迁移逻辑」会把用户自己写的路径也改掉——因为它无法区分「作者的旧路径」和「用户的合法路径」。最终方案是**只有占位符才参与迁移**，绝对路径一律不动。

#### 第二层：额外偏好 `SE-AGENTS.md`（本机私有，不进包）

放**只对这台机器成立**的东西：网络代理、VPN 配置、软件安装路径、硬件特殊之处、个人工作习惯。

这一层刻意**不随安装包分发**（只发一个空骨架）。原因：这些内容换设备无意义，共享出去还可能泄露内网信息。

`opencode.json` 里两层同时加载：

```json
"instructions": [
  "~/WLstudio SE/SE-AGENTS.md",
  "~/WARMUP.md"
]
```

用 `~/` 而不是绝对路径，内核原生支持，换用户目录也成立。

#### 预热层：`WARMUP.md`

新会话开局第一时间读，用来**替代「靠堆积历史对话来预热」**——用一份紧凑的知识快照让模型立即进入协作状态，而不是每次重发几十万 token 的旧对话。

三层配合的效果：**通用规则稳定 → 本机配置隔离 → 开局状态轻量恢复**。

---

### 三、外置上下文（上下文成本工程）

这一节是整个项目里最"反直觉"的部分：**目标不是"少说话"，而是让每一轮的 token 都可预测、可复用**。

#### 前提：DeepSeek / 大多数 API 是「无状态 + 前缀缓存」

每次请求都要把全部 messages 重发一遍。服务端只有**硬盘前缀缓存**——前缀相同才命中缓存价，**前缀里任何一个字节变化，其后全部按全价重算**。

所以：
- 成本 ≈ **工具轮次 × 上下文大小**（不是调用次数）
- **改写历史中段 = 缓存全失效** ← 这是大部分"上下文优化"插件反而更贵的原因

#### 三条原则

| 原则 | 含义 |
|---|---|
| **P1 只追加，不改写前缀** | 历史一旦写出就冻结。任何"回头整理历史"的操作都会打掉缓存 |
| **P2 大内容在产生那一刻外置** | 落盘 + 留短引用，让该位置此后永久稳定（不会每轮反复改写同一处） |
| **P3 用检索代替堆叠** | 知识放外部可检索存储，只追加相关片段到当前消息尾部 |

#### 四个 hook 的实现

**1) `experimental.chat.messages.transform` —— 图片一次性外置**

图片是最大的浪费源（实测单次请求曾达 21.8 MB / 47 图）。关键在于图片不只在独立 `FilePart` 里，还挂在 `ToolPart.state.attachments`——只处理前者会漏掉一半。

策略：**当前轮图片原样保留，历史轮的图片替换为磁盘路径说明**。因为替换后该位置变成文本，下一轮不会再被识别为图片，所以天然单调、不会反复改写。

同一 hook 里还会剥离历史 `reasoning` part——避免把旧推理当 `reasoning_content` 回传（省 token + 稳定前缀）。

**2) `tool.execute.after` —— 大输出落盘**

工具输出超过 12000 字符时，落盘并只保留「头 4KB + 说明 + 尾 1KB」。在**产生那一刻**定型（P2），之后不再变。

**3) `chat.message` —— BM25 检索注入**

见「经验树」一节。注入到当前用户消息尾部而非 system——**因为逐轮变化的 system 内容会打掉前缀缓存**。

**4) `experimental.session.compacting` —— 压缩提示最小化**

提供极简压缩指令，让主模型产出 ≤2KB 的结构化 digest（已知结论/未决问题/关键文件/下一步）。压缩后上下文真正落低，消除"压缩震荡"（压缩后仍然很大、于是又触发压缩）。

#### 一个刻意的取舍

PLAN 里原本还有「会话常驻记忆注入 system」，**被有意省略**——任何逐轮变化的 system 内容都会打掉前缀缓存。跨会话连续性改由「经验检索 + 交接文档」承担。

> 这个插件**无第三方依赖、无网络、无模型、无子进程**，删文件重启即可卸载。存量会话里已外置的图片与输出不会自动还原（这是有意的：还原等于把成本再加回来）。

---

### 四、浏览器桥接

目标很简单：**让 AI 真的能打开浏览器、点按钮、读页面**，而不是靠 HTTP 请求猜内容。

难点不在"怎么点"，在**怎么让多个会话同时用而不打架**。

#### 硬约束：Firefox 每个实例只有一条 WebDriver BiDi 会话

翻源码确认的（`WebDriverBiDi.sys.mjs`）：`createSession()` 里有 `if (this.#session) throw new SessionNotCreatedError("Maximum number of active sessions")`。

更坑的是：**关 socket 不释放会话**。`onConnectionClose()` 只调 `unregisterSession()`，把连接对象上的引用置空，**并不调用 `deleteSession()`**——全局槽位永久被占，只能重启浏览器。没有 pref 能放宽上限。

所以持有者必须满足两个条件：**进程级单例**、**活得比内核久**。

#### 架构：单例持有一条上游会话 + 按 tab 多路复用

```
模型/插件（内核侧，可被热重载、可随内核重启）
        │  POST /call {caller, method, params}   x-wl-token
        ▼
桌面壳主进程（独立于内核生命周期，进程级单例）
        │  唯一一条 BiDi 会话
        ▼
     Firefox (9222)
        │
        ├── tab A  ── caller 1
        ├── tab B  ── caller 2
        └── tab C  ── caller 3
```

- **上游**：一条 BiDi 会话，由桌面壳持有。内核重启、插件热重载都不会丢掉它。
- **下游**：按 `browsingContext`（tab）隔离。**同 tab 内命令 FIFO 串行，不同 tab 完全并发**。
- **租约**：没有指定 context 的调用者自动领一个专属 tab，调用者消失时释放租约（默认保留 tab，避免把用户正在看的东西关掉）。
- **事件路由**：BiDi 事件按 `context` 分发，不会串台。
- **发现机制**：`~/.config/wlstudio/firefox-bridge.json` 写 `{url, port, token, pid}`，插件读它来找到服务，不存在则报 `firefox.bridgeUnavailable`。
- **鉴权**：环回 HTTP + `x-wl-token` 头。

#### 实测数据

```
firefox 进程 = 0 → navigate → 进程 13，session 1，upstream:"managed"
3 个 tab 并发 navigate+evaluate = 2084ms（真并发，各返回自己页面）
第 4 个 tab 导航后，前 3 个 tab 页面不受影响（tab 级隔离）
stop 后立刻可重新 attach = 0 泄漏
```

#### 三个具体的坑

**坑 1：热重载丢引用 → 会话泄漏。** 插件 runtime 曾是模块级变量，插件热重载后旧 socket 引用丢失，而 socket 关闭又不释放会话，于是槽位永远占着。解法：runtime 挂 `globalThis` 跨重载复用 + 代际跟踪，`setup` 返回 cleanup 主动 `session.end`。

**坑 2：attach 失败就自动开新浏览器。** 原逻辑在 catch 里直接 `launchFirefox()`，用户看到的是"我什么也没让它开，它自己弹了个浏览器出来"。解法：attach 失败**改抛错**（`firefox.attachFailed:<原因>`），自动启动改为明确策略——**默认允许自己启动**（安装器已经知道浏览器在哪），但可由 `WLSTUDIO_BROWSER_AUTOLAUNCH=0` 关闭。

**坑 3：页面加载了但用户看不见。** BiDi 没有"窗口焦点"概念，`navigate` 只切浏览器内部 tab，窗口还在 IDE 后面盖着，用户以为"什么都没打开"。解法：navigate 后用 Win32 `SetForegroundWindow` + `ShowWindow` 把窗口提到前台（仅 win32，1.5s 超时，失败不影响调用）。

> 还有一个只在服务器上才暴露的问题：如果 Firefox 是由**计划任务以 SYSTEM 身份在 session 0** 拉起的，它就没有可见桌面，`SetForegroundWindow` 跨 session 永远无效。判断"窗口是否真的可见"也必须在 **session 1 内部**跑探针——从 WinRM（session 0）查 `MainWindowHandle` 永远是 0，是假象。

---

### 五、分发工程（装到别人机器上不出事）

这些不是"亮点功能"，但决定了能不能真的交到别人手里。

| 机制 | 解决的问题 |
|---|---|
| **首启 seed（只补不覆盖）** | 新装机器自动获得可用的插件、偏好、空经验库骨架；升级不覆盖用户已改的内容 |
| **路径占位符渲染 + 每次启动自愈** | 换盘符/换用户名后文档路径自动修正，不用重新出包 |
| **特调 Firefox（可选勾选）** | 独立 profile、自带调试端口、关遥测提示；安装时可选，卸载时单独询问是否删除 |
| **一键卸载** | 停进程 → 找官方卸载器 → 自动备份偏好与经验库 → 清缓存与配置 → 报告残留。默认保留经验库，`-PurgeAll` 才全删 |
| **出包前 PII 扫描** | 扫成品解包（含二进制），覆盖 API key / 作者路径 / 用户名 / 内网 IP / 私钥；命中即中止出包 |
| **updater 指向隔离** | 防止自动更新拉到上游版本把本产品覆盖掉 |

> 出包的血泪教训：`--prepackaged` 打包的源头是**构建产物目录**，不是源码 `resources/`。改了资源却只改源码，包里永远是旧的——一个明文 API key 就是这样在多个版本里流通的。

---

## 其他特性

- **分模型彩蛋**：会话当前模型含 `deepseek` 时，聊天区背景换上指定插画（不透明度 20%），**按会话隔离**，切模型即切换
- **语言可选**：20 种语言，可选「跟随系统 / 固定某种 / 完全不插语言段」。指定语言时写入最高优先级约束，并要求模型**直接用目标语言思考**而不是先想英文再翻译
- **配额窗口重试**：区分「窗口限额（5 小时/日/周）」与「余额不足」——前者按固定间隔无限重探，后者立即失败。避免窗口重开时任务已经死了
- **会话笔记（note）**：每会话私有、每轮自动注入的硬事实便签，跨压缩存活，用来存"压缩后会忘但后面还要用"的东西
- **Office/压缩包读取**：`.docx`/`.xlsx`/`.pptx`/`.zip`（含 ZipCrypto 已知明文攻击）内置支持
- **思考监控与工具面板**：GUI 扩展形式，可视化和干预 agent 运行过程

---

## 测试环境

| 项 | 值 |
|---|---|
| 操作系统 | **Windows 10**（主要测试平台）；安装包为 x64 |
| 桌面壳 | Electron 44 |
| UI | SolidJS |
| 内核 | 独立进程（Bun 编译），与桌面壳分离 |
| 浏览器 | Firefox Developer Edition（可选安装，特调版独立 profile） |

已验证的部署场景：全新机器首装、跨盘符重装、卸载后重装、服务器远程静默安装。

---

## 与 opencode 的关系

- **上游**：[opencode](https://github.com/anomalyco/opencode)，**MIT License**
- WLstudio 在其基础上做二次开发：重构分发与偏好体系、新增经验树与上下文外置插件、重做浏览器桥接为进程级单例服务、替换品牌与默认配置
- **MIT 允许修改、改名、再分发乃至商用**。本项目保留上游版权声明与许可全文（安装目录 `resources/licenses/` 内）
- 上游商标（OpenCode / Anomaly Innovations, Inc.）归其所有者，本项目仅作指示性说明，不主张任何商标权利
- 本产品全名「**无量工作台**」，`WLstudio` 为英文名

---

## 快速开始

### 安装

从 Releases 下载 `wlstudio-desktop-<version>-win-x64.exe`，双击安装。

安装过程中可勾选是否安装**特调版 Firefox Developer Edition**（独立配置，不影响系统里其它浏览器）。

### 首次启动

会自动生成：

```
%USERPROFILE%\AGENTS.md                  基础偏好（路径已渲染为本机真实路径）
%USERPROFILE%\WARMUP.md                  启动预热
%USERPROFILE%\WLstudio SE\SE-AGENTS.md   本机私有偏好（空骨架，自行填写）
%USERPROFILE%\.config\wlstudio\           配置与插件
<安装盘>:\WLstudio-data\ex-bags\          经验库（11 个域目录）
```

### 配置模型

配置文件：`%USERPROFILE%\.config\wlstudio\opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "<provider>/<model>",
  "language": "zh",
  "instructions": ["~/WLstudio SE/SE-AGENTS.md", "~/WARMUP.md"],
  "providers": {
    "<provider>": {
      "name": "<provider>",
      "package": "@ai-sdk/openai-compatible",
      "settings": {
        "baseURL": "https://.../v1",
        "apiKey": "<your key>"
      },
      "models": {
        "<model>": {
          "name": "<model>",
          "capabilities": { "tools": true, "input": ["text", "image"], "output": ["text"] },
          "limit": { "context": 1000000, "output": 384000 }
        }
      }
    }
  }
}
```

> **注意**：自定义 provider 必须显式声明 `capabilities.input`。漏掉时即使模型本身多模态，内核也会把图片替换成占位文字——模型根本没收到图。

### 卸载

桌面「一键卸载 WLstudio」。默认删除程序与配置、**保留经验库**；`-PurgeAll` 全删。卸载前会自动备份偏好与经验库。

---

## 目录结构（关键部分）

```
packages/
├── core/                 内核：会话、工具、插件、提示词
├── ai/                   provider 抽象、错误分类、重试策略
├── desktop/              Electron 主进程、打包、seed
│   └── resources/
│       ├── seed/         首启分发内容（config / prefs / ex-bags 骨架）
│       ├── tools/        卸载、检测脚本
│       └── windows/      NSIS 安装脚本
├── gui-extensions/       GUI 扩展（浏览器桥接、思考监控）
│   └── wl-browser/       BiDi 客户端、单例桥接服务、面板
├── app/                  SolidJS 渲染层
├── ui/                   组件库
└── schema/               配置与数据契约
```

---

## English TL;DR

WLstudio is a desktop AI coding workbench built on top of [opencode](https://github.com/anomalyco/opencode) (MIT).

It focuses on five problems upstream does not address directly:

1. **Experience tree** — a searchable knowledge base with a 5-layer controlled taxonomy. The fifth layer (`level`) records whether a conclusion has been *disproven* (`EXCLUDED`), so a single `grep` prevents the agent from retrying known dead ends. Relevant fragments are auto-injected via BM25 into the current user message.
2. **Two-layer preferences** — distributable base rules (`AGENTS.md`, path placeholders rendered at install time and self-healed on every launch) separated from machine-private settings (`SE-AGENTS.md`, never shipped).
3. **Externalized context** — append-only by design to preserve prefix cache: images offloaded once when they become history, tool output over 12 KB spilled to disk, retrieval instead of accumulation, minimal compaction digests.
4. **Browser bridge** — a process-level singleton owning the single Firefox BiDi session (Firefox allows only one per instance, and closing a socket does *not* release it), multiplexed downstream by tab: FIFO within a tab, fully concurrent across tabs.
5. **Distribution engineering** — seed-on-first-launch (never overwrites user data), placeholder path rendering, optional tuned Firefox, one-click uninstall, and a mandatory PII scan of the unpacked artifact before every release.

**Tested on Windows 10 (x64).** Not affiliated with or endorsed by the opencode project.

---

## License

MIT — see [`LICENSE`](./LICENSE). Upstream copyright notices are retained; see `resources/licenses/` in the installed application for the full upstream license and third-party notices.
