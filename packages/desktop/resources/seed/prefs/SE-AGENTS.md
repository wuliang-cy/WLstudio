# 额外偏好设置（SE-AGENTS）

> **本文件为初始骨架**，用于保存你的个性化偏好，以及本机特定配置（网络代理、VPN、软件安装路径等）。
> 基础通用规则在工作区的 `AGENTS.md`；本文件只放与这台机器 / 你个人相关的内容。
> 可直接编辑，也可以随时删除重建。

---

## 使用说明

- 内核通过 `opencode.json` 的 `instructions` 数组自动读取本文件（无需工具调用，每轮都在上下文里）。
- 建议记录的内容：
  - 本机网络环境（HTTP/SOCKS 代理地址、是否需要代理才能访问外网）
  - 常用软件的安装路径（编译器、SDK、工具链等）
  - 硬件特殊之处（多显卡、非标准盘符、外接设备等）
  - 个人工作习惯（回复语言、代码风格、提交规范等）
- 与这台机器无关的通用规则请写进工作区的 `AGENTS.md`，保持本文件只承载「本机专属」信息。

---

## 填写示例（按需启用，不需要就整段删掉）

```markdown
## 网络代理

- HTTP 代理：http://127.0.0.1:7890
- SOCKS5 代理：socks5://127.0.0.1:7891
- 说明：访问 GitHub / npm 镜像失败时走代理

## 常用工具路径

- Node：C:\Program Files\nodejs\node.exe
- Python：%USERPROFILE%\scoop\shims\python.exe
- Git：C:\Program Files\Git\bin\git.exe
- 包管理器镜像：https://registry.npmmirror.com

## 工作习惯

- 默认用中文回复
- 生成的文件统一输出到工作区目录
```

---

（以下留白，供你自行填写本机配置。）
