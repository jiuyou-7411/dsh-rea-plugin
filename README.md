# dsh-rea-plugin

REA 逆向工作台，为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供 220 个逆向工具、72 篇离线文档和 4 个 Agent 技能。

装完插件，Android 分析立刻可用；native 分析需点一次 Ghidra 安装。

---

## 装了什么

| 类别 | 数量 | 来源 |
|---|---|---|
| **REA MCP 工具** | 207 | 上游 [rea-agents](https://github.com/morluto/rea)，自建桥接，无需配 profile |
| **移动端工具** | 6 | 内置 [MobileRE-Skill](https://github.com/index-login/MobileRE-Skill)：脱壳、Frida、反注入检测、SO 分析、模拟执行 |
| **本地工具** | 7 | 引擎安装、能力矩阵、脱壳、CLI 直调、文档检索 |
| **文档** | 72 篇 | 离线打包，1.2 MB |
| **Agent 技能** | 4 | 自动部署到 DSH 技能目录 |

---

## 安装

```bash
cd ~/.dsh/profiles/desktop
npm install dsh-rea-plugin
```

然后在 `cordis.yml` 加一行并重启 DSH：

```yaml
- id: rea-host
  name: 'dsh-rea-plugin'
  config:
    reaVersion: 6.7.0
    autoInstallProviders: true
```

详细步骤见 [INSTALL.md](INSTALL.md)。

---

## 它自己会做的事

装完插件、重启 DSH，以下全部自动完成，**不用点任何按钮**：

| 项目 | 耗时 | 失败处理 |
|---|---|---|
| 下载 `rea-agents`（207 个工具） | 5–30 秒 | 自动重试 5 次，退避共 52 秒 |
| 部署 4 个 Agent 技能 | <1 秒 | 写入 `.dsh/skills/rea/` 和 `.agents/skills/rea/` |
| 安装 apktool + jadx | 约 1 分钟 | 失败会显示原因和修复建议 |
| 安装 7 个 Python 包 | 约 2 分钟 | 自动测速选最快的镜像 |

**只有三样需要你主动点**：

| 项目 | 大小 | 为什么手动 |
|---|---|---|
| Ghidra | 543 MB | native 分析用，不是所有人都需要 |
| JDK 21 | 196 MB | 只有装 Ghidra 才需要 |
| Frida 引擎 | npm 全局 | 会写全局 npm，可能和已有冲突 |

---

## 界面

六个页面，顶部导航（不是左侧——插件本身就在 DSH 侧边栏里）：

| 页 | 能看什么 |
|---|---|
| **总览** | 工具总数、REA 成功率、常用工具、近期告警（中文解释） |
| **实时流** | 每次调用的参数和返回，点开看完整内容 |
| **错误** | 按错误类型聚合，中文说明「什么错 / 为什么 / 怎么办」 |
| **服务状态** | 六项检查，异常项给具体修复步骤 |
| **引擎** | 引擎、JDK、Python 依赖，每项独立安装/卸载 |
| **能力** | 8 类目标的分析能力、依赖哪个引擎 |

---

## 热更新

插件**不能替换自己正在运行的代码**——Node 还开着那些文件，Windows 上连改名都会失败。所以更新是这样工作的：

1. 每次打开面板，检查 npm 上有没有新版本（结果缓存 6 小时）
2. 有新版就在顶部显示横幅，写出当前版本、最新版本和确切命令
3. 你执行 `npm install dsh-rea-plugin@latest`，重启 DSH 生效

**前端会热重载，Host 端必须重启。** 这是模块系统的限制，不是省略。

如果当前是本地开发副本（`link:` / `file:` 依赖），横幅不显示——那说明版本差异来自你自己的改动，不是落后。

---

## 需要什么

| 要求 | 检查 | 不满足会怎样 |
|---|---|---|
| Node.js 22.19+ / 24.11+ / 26+ | `node -v` | 插件不加载 |
| 网络（首次） | 能访问 npm | 自动重试 5 次后提示 |
| Python 3.9+（可选） | `python -V` | 6 个移动端工具不可用，其余正常 |

---

## 开发和发布

```bash
# 刷新上游内容（技能、文档索引、文档正文）
npm run sync:all

# 从上游内容重建 DSH 技能
npm run build:skills

# 打包前自检：文件完整性、数量、禁止路径、硬编码路径
npm run verify

# 打包
npm pack
```

`sync:all` 把上游内容 pin 到具体 commit，所以同一个插件版本永远对应同一份文档和技能。

---

## 和上游的关系

本插件是 [morluto/rea](https://github.com/morluto/rea) 的 DSH 集成层，不修改上游代码：

- 工具面与上游 MCP **完全一致**（207 个，无裁剪）
- 技能来自上游 `.agents/skills`，pin 到 commit `d672cc2`
- 文档来自上游 `docs/`，pin 到 commit `25bea07`
- MobileRE 是独立项目，补 Android 动态分析能力

---

## 许可

MIT。内置第三方内容各自遵循原项目许可，详见 [LICENSE](LICENSE)。
