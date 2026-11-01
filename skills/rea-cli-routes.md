---
name: rea-cli
description: 用 rea 工具做逆向时的命令路由表与陷阱清单。当你需要知道该用哪条 REA 命令、命令名怎么拼、或者大结果怎么处理时加载本技能。
---

# REA 命令路由表

所有 REA 操作都走同一个工具 `rea`，它自己决定走命令行还是 MCP，你不用关心：

```
rea(command="<命令名>", args=["<参数>", ...], format="json")
```

- **命令名**：下划线和连字符都接受（`analyze_function` 与 `analyze-function` 等价）
- **参数**：走命令行的命令用 `args`（位置参数数组）；只有 MCP 支持的命令用 `input`（命名对象）
- **不知道命令名**：`rea(command="help")` 拿完整清单
- **参数写错**：会连同该命令的完整用法一起返回，照着改即可

---

## 一、先做两件侦察

```bash
rea(command="doctor", format="json")
rea(command="capabilities", format="json", tokenLimit=2000)
```

- `doctor` 告诉你哪些引擎真的可用、缺什么
- `capabilities` 列出每个操作的可用性与副作用。**输出很大（50KB+）**，务必带 `tokenLimit`，或先落盘再筛

---

## 二、CLI 与 MCP 工具名不一样

这是最容易踩的坑。**CLI 没有 `open_binary`，也没有 `open` 子命令** —— 它是无状态的，每条命令直接收路径。

| MCP 工具（有 schema） | CLI 子命令 | 说明 |
|---|---|---|
| `open_binary` | **不存在** | CLI 每条命令自带路径，无需先打开 |
| `analyze_function` | `function <path>` | |
| `procedure_pseudo_code` | `decompile <path>` | |
| `list_procedures` | `search <path>` | 配合筛选参数 |
| `search_strings` | `search <path>` | 按字符串筛 |
| `xrefs` | `xrefs <path>` | |
| `inspect_binary_layout` | `inspect-binary-layout <path>` | 不需要引擎 |
| `inspect_android_package` | `inspect-android-package <apk>` | |
| `inspect_android_class` | `inspect-android-class <apk>` | |
| `inspect_android_method` | `inspect-android-method <apk>` | |
| `analyze_javascript_application` | `analyze-javascript-application <dir>` | |
| `inspect_artifact` | `inspect-artifact <path>` | |
| `extract_firmware` | `extract-firmware <path>` | |

**规则：MCP 工具名把下划线换成连字符，通常就是 CLI 子命令；但 `open_*` 系列在 CLI 里没有对应。**

---

## 三、目标路由表

按目标类型选命令，**不要凭记忆拼**：

| 目标 | 命令 |
|---|---|
| 原生可执行文件 / 库 | `analyze <path>` 总览 → `function` / `decompile` / `xrefs` / `search` 聚焦 |
| Android APK 代码 | `inspect-android-package` → `search-android-classes` → `inspect-android-class` → `inspect-android-method` → `trace-android-references` |
| Android APK 资源 | `decode-android-resources` |
| JavaScript / Electron 应用 | `analyze-javascript-application <目录>` |
| 归档/包成员清单（ZIP/APK/IPA/MSIX/DMG） | `inspect-artifact`；要落地用 `extract-artifact` |
| .NET 托管程序集 | `inspect-managed-artifact`；成员用 `inspect-managed-members` |
| 固件镜像 | `inspect-firmware-regions`；提取用 `extract-firmware` |
| WebAssembly | `inspect-wasm-artifact` |
| Linux ELF 布局（不需引擎） | `inspect-binary-layout` |
| ELF core 崩溃 | `inspect-recorded-crash` |
| PE 资源树 | `inspect-pe-resources` |
| 浏览器页面 | `list-browser-targets` → `inspect-web-page` / `analyze-web-bundle` |
| HAR / mitmproxy 抓包 | `inspect-web-network-capture` |
| Electron 运行时 | `list-electron-targets` → `inspect-electron-page` |
| EVM 字节码 | `inspect-evm-interface`（显式 `raw`/`hex`） |
| adb 设备 | `inspect-adb-device` / `inspect-adb-package` / `capture-adb-screen` |

**没有对应命令的**：CLI 里没有 WASM 之外的某些实验性操作时，如实说明「当前 CLI 没有这条命令」，不要硬拼一个不存在的子命令。

---

## 四、大结果处理（必须遵守）

一次分析实测约 1 MB JSON，真实应用可能到数百 MB。**不要把整份 JSON 读回上下文。**

```bash
# 1. 先落盘
rea(command="analyze", args=["<path>"], format="json") > evidence.json

# 2. 再用 inspect-analysis-view 摘要或分页
rea(command="inspect-analysis-view",
        args=["evidence.json"], format="json")
```

分页投影：

```json
{"view": {"kind": "page", "collection": "modules", "offset": 0, "limit": 32}}
```

完整证据导出：

```bash
rea(command="evidence-export", args=["<source>", "<output>"])
```

### 输出格式

`rea` 的 `format` 参数控制 CLI 的 `--format`：

| 值 | 用途 |
|---|---|
| `json` | 结构化，最省 token 且易解析 |
| `toon` | 更紧凑，适合人读 |
| `md` | Markdown 表格 |
| `jsonl` | 流式 |

`tokenLimit` 参数对应 `--token-limit`，**大输出一定要带上**。

---

## 五、证据纪律

- 结论必须区分 **已观测（observed）/ 推断（inferred）/ 未知（unknown）**
- 保留 `limitations` 与不完整覆盖；覆盖不到就报「未知」，不要说成「不存在」
- `unknown` / `truncated` / `unsupported` / `skipped` 是**结论的一部分，不是失败**
- 绝不暗示静态分析观测到了执行

---

## 六、环境限制

- 原生深分析需要 Ghidra / Hopper / IDA（用 `doctor` 看）
- 缺引擎时改用静态能力：JavaScript/Electron、.NET、APK、打包物、EVM
- Windows 上 ELF 布局、core 崩溃、固件、EVM 的部分能力是代码级不可用（不是没配好），遇到时如实说明并给替代方案
- Hopper 仅 macOS/Linux

---

## 七、并行

CLI 是**无状态**的，每条命令是独立进程：

- 多个分析可以并行跑不同目标
- 唯一要避免的是**并发写同一个输出文件路径**——每个任务用各自独立的输出文件

这一点比 MCP 模式强：MCP 会话同一时刻只有一个活动目标。
