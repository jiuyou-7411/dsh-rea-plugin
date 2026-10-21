# dsh-rea-plugin 安装说明

REA 逆向工作台：220 个工具、72 篇离线文档、4 个 Agent 技能。装完即用，无需改配置。

本插件通过 **GitHub 分发**，不走 npm。

---

## 安装

### 前置：确认 Node.js 版本

```bash
node -v
```

需要 **22.19+**、**24.11+** 或 **26+**。低于这个版本插件不会加载。

### 方式一：克隆仓库（推荐）

```bash
# 1. 进入 DSH 的 profile 目录
cd ~/.dsh/profiles/desktop
#   Windows PowerShell：cd $env:USERPROFILE\.dsh\profiles\desktop

# 2. 克隆插件
git clone https://github.com/jiuyou-7411/dsh-rea-plugin.git plugins/dsh-rea-plugin

# 3. 声明为本地依赖
npm install ./plugins/dsh-rea-plugin
```

这种方式的好处：以后更新只要 `git pull`。

### 方式二：下载压缩包

从 Releases 下载 `dsh-rea-plugin-3.0.0.tgz`：

```bash
cd ~/.dsh/profiles/desktop
npm install /path/to/dsh-rea-plugin-3.0.0.tgz
```

这种方式装的副本没有 `.git`，更新需要重新下载。

### 方式三：DSH 插件管理器

DSH 界面 → **插件管理器** → 安装本地包 → 指向 `.tgz` 文件。

---

## 装完必须做的两件事

### 1. 在 cordis.yml 里启用

编辑 `~/.dsh/profiles/desktop/cordis.yml`，加这一段：

```yaml
- id: rea-host
  name: 'dsh-rea-plugin'
  config:
    reaVersion: 6.7.0
    autoInstallProviders: true
    maxProviderDownloadMb: 2048
    providerEnv: {}
```

### 2. 重启 DSH

**完全关闭再打开**，不是刷新页面。Host 端代码只在重启后加载。

---

## 首次启动会自动做什么

不需要点任何按钮：

| 项目 | 耗时 | 失败处理 |
|---|---|---|
| 下载 `rea-agents`（207 个工具） | 5–30 秒 | 自动重试 5 次，退避共 52 秒 |
| 部署 4 个 Agent 技能 | <1 秒 | 写入 `.dsh/skills/rea/` 和 `.agents/skills/rea/` |
| 安装 apktool + jadx | 约 1 分钟 | 面板显示原因和修复建议 |
| 安装 7 个 Python 包 | 约 2 分钟 | 自动测速选最快镜像 |

**装完 Android 分析立刻可用。**

### 需要手动点的三项

| 项目 | 大小 | 为什么手动 |
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
| **网络**（首次） | 能访问 GitHub | 自动重试 5 次后报错，可在面板点重新连接 |
| **Python 3.9+**（可选） | `python -V` | 6 个移动端工具不可用，其余正常 |

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
node -e "import('dsh-rea-plugin').then(m => console.log('导出:', Object.keys(m)))"
```

---

## 更新

### 克隆安装的

```bash
cd ~/.dsh/profiles/desktop/plugins/dsh-rea-plugin
git pull
npm install
```

然后重启 DSH。面板顶部横幅会显示落后的提交数：

```
● 代码落后上游 3 个提交
  git pull && npm install
```

### tgz 安装的

重新下载新版 `.tgz`，再用 `npm install` 覆盖。

---

## 常见问题

**工具数显示 207 而不是 220**

`mobile_*` 和本地工具没注册。检查日志里有没有 `[rea] host active`。

**面板显示「MCP 未连接」**

首次启动可能正在下载。等 30 秒；还不行就点「重新连接」。日志在 `~/.dsh/logs/desktop-next.log`，搜 `[rea]`。

**技能没出现**

检查两个目录：

```bash
ls ~/.dsh/skills/rea/          # 应有 4 个 .md
ls ~/.agents/skills/rea/       # 应有 4 个 .md
```

都没有就是插件没启动成功。

**native 工具全报 `Ghidra not configured`**

引擎页装 Ghidra。装之前确认 JDK 21 就绪——Ghidra 11.2+ 在 Java 17 上拒绝启动。

**JDK 下载很慢或卡住**

面板会显示下载源和速度。实测清华镜像 47 MB/s，官方源 0.04 MB/s，插件会自动优先用镜像。

**改了 Host 代码不生效**

必须重启 DSH。HMR 只热重载前端（`client.js`），Host 端（`lib/*.js`）不会。

**报错看不懂**

面板「错误」页有中文说明，分三段：什么错、为什么、怎么办。原始英文报错点开可看。

---

## 卸载

```bash
cd ~/.dsh/profiles/desktop
npm uninstall dsh-rea-plugin
```

清掉数据和引擎：

```bash
rm -rf ~/.dsh/skills/rea
rm -rf ~/.agents/skills/rea
rm -rf ~/.dsh/rea-engines      # 引擎，约 700 MB
rm -rf ~/.dsh/rea-jdk          # 私有 JDK，约 300 MB
```

从 `cordis.yml` 删掉 `rea-host` 那一行，重启。

---

## 许可

MIT。内置内容来源：

| 内容 | 来源 | 许可 |
|---|---|---|
| `rea-agents` MCP 服务 | [morluto/rea](https://github.com/morluto/rea) | MIT |
| Agent 技能 | 同上 `.agents/skills` @ `d672cc2` | MIT |
| 文档 72 篇 | 同上 `docs/` @ `25bea07` | MIT |
| MobileRE 工具 | [index-login/MobileRE-Skill](https://github.com/index-login/MobileRE-Skill) | MIT |
