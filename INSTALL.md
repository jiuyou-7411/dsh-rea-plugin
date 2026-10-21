# dsh-plugin-rea 安装说明

REA 逆向工作台：220 个工具、72 篇离线文档、4 个 Agent 技能。装完即用，无需改配置。

---

## 三种安装方式

### 方式一：本地文件安装（最简单）

拿到 `dsh-plugin-rea-2.8.1.tgz` 后，在 DSH 的 profile 目录执行：

```bash
cd ~/.dsh/profiles/desktop
npm install /path/to/dsh-plugin-rea-2.8.1.tgz
```

Windows：

```powershell
cd $env:USERPROFILE\.dsh\profiles\desktop
npm install C:\path\to\dsh-plugin-rea-2.8.1.tgz
```

### 方式二：从 npm 源安装

包发布到 npm 后：

```bash
cd ~/.dsh/profiles/desktop
npm install dsh-plugin-rea
```

### 方式三：用 DSH 的插件管理器

在 DSH 界面里打开 **插件管理器**，选择「安装本地包」，指向 `.tgz` 文件。

---

## 装完必须做的两件事

### 1. 在 cordis 配置里启用

编辑 `~/.dsh/profiles/desktop/cordis.yml`，加一行：

```yaml
- id: rea-host
  name: 'dsh-plugin-rea'
  config:
    reaVersion: 6.7.0
    autoInstallProviders: true
    maxProviderDownloadMb: 2048
    providerEnv: {}
```

`autoInstallProviders: true` 是默认行为，写了更明确。

### 2. 重启 DSH

完全关闭 DSH 再打开，不是刷新页面。Host 端代码只在重启后加载。

---

## 首次启动会自动做什么

不需要点任何按钮：

| 项目 | 耗时 | 说明 |
|---|---|---|
| 下载 `rea-agents` | 5–30 秒 | 通过 npx，失败自动重试 5 次（总退避 52 秒） |
| 安装 4 个 Agent 技能 | <1 秒 | 写入 `.dsh/skills/rea/` 和 `.agents/skills/rea/` |
| 安装 `apktool` + `jadx` | 约 1 分钟 | 到 `~/.dsh/rea-engines/` |
| 安装 Python 依赖 | 约 2 分钟 | 仅当本机有 Python 3 |

**装完 Android 分析立刻可用。**

### 需要手动点一次的

| 项目 | 大小 | 原因 |
|---|---|---|
| **Ghidra** | 543 MB | native 分析用，不是所有人都需要 |
| **JDK 21** | 186 MB | 只有装 Ghidra 才需要 |
| **Frida 引擎** | npm 全局 | 会写全局 npm，可能和已有冲突 |

面板「引擎」页每项都有独立按钮。

---

## 前置条件

| 要求 | 检查方式 | 不满足会怎样 |
|---|---|---|
| **Node.js 22.19+ / 24.11+ / 26+** | `node -v` | 插件不加载 |
| **网络**（首次） | 能访问 npm | 自动重试 5 次后报错，可在面板点重新连接 |
| **Python 3.9+**（可选） | `python -V` | 6 个 `mobile_*` 工具不可用，其余正常 |

Python 不是必需的：13 个脚本是纯标准库，只有动态分析那几个需要。

---

## 装完怎么验证

### 面板

DSH 侧边栏 → REA。应该看到：

```
● 分析引擎     220 个工具     REA 207 · 移动端 6 · 本地 7
```

工具数是 **220** 就对了。

### Agent

问它：

> REA 有哪些技能？

应该列出这 4 个：

- `rea` — 核心方法论（怎么路由目标、先做什么）
- `rea-analysis-optimization` — 降低成本
- `rea-tool-design` — 工具设计原则
- `rea-workbench` — 本插件说明

### 命令行

```bash
cd ~/.dsh/profiles/desktop
node -e "import('dsh-plugin-rea').then(m => console.log('导出:', Object.keys(m)))"
```

---

## 常见问题

**工具数显示 207 而不是 220**

`mobile_*` 和本地工具没注册。检查 Python 是否存在，以及日志里有没有 `[rea] host active`。

**面板显示「MCP 未连接」**

首次启动可能正在下载。等 30 秒；如果还不行，点「重新连接」。日志在 `~/.dsh/logs/desktop-next.log`，搜 `[rea]`。

**技能没出现**

检查这两个目录：

```bash
ls ~/.dsh/skills/rea/          # 应有 4 个 .md
ls ~/.agents/skills/rea/       # 应有 4 个 .md
```

都没有就是插件没启动成功。

**native 工具全报 `Ghidra not configured`**

引擎页装 Ghidra。装之前平台会提示先装 JDK 21。

**改了 Host 代码不生效**

必须重启 DSH。HMR 只热重载前端（`client.js`），Host 端（`lib/*.js`）不会。

---

## 卸载

```bash
cd ~/.dsh/profiles/desktop
npm uninstall dsh-plugin-rea
```

同时清掉：

```bash
rm -rf ~/.dsh/skills/rea
rm -rf ~/.agents/skills/rea
rm -rf ~/.dsh/rea-engines      # 引擎，约 700 MB
rm -rf ~/.dsh/rea-jdk          # 私有 JDK，约 300 MB
```

然后从 `cordis.yml` 删掉 `rea-host` 那一行，重启。

---

## 版本与更新

```bash
npm view dsh-plugin-rea version        # 看最新
npm install dsh-plugin-rea@latest      # 升级
```

升级后重启。技能文件会自动刷新，用户改过的会保留并报告。

---

## 许可

MIT。内置内容来源：

| 内容 | 来源 | 许可 |
|---|---|---|
| `rea-agents` MCP 服务 | [morluto/rea](https://github.com/morluto/rea) | MIT |
| Agent 技能 | 同上 `.agents/skills` @ `d672cc2` | MIT |
| 文档 72 篇 | 同上 `docs/` @ `25bea07` | MIT |
| MobileRE 工具 | [index-login/MobileRE-Skill](https://github.com/index-login/MobileRE-Skill) | MIT |
