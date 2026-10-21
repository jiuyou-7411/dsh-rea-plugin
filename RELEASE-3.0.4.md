# v3.0.4 - 界面全中文化 + GitHub 导航

## 🎯 核心改进

### 界面全中文
- **常用工具列表**：46 个工具的中文名映射，原始 ID 作为副标题小字显示
  - `win_bash` → 执行命令
  - `write` / `read` / `edit` → 写文件 / 读文件 / 修改文件
  - `plugin_manager` → 插件管理
  - 完整列表见源码 `TOOL_LABELS`

- **错误提示中文化**
  - 新增规则：`file changed since it was read` → "文件在你读过之后又被改动了"
  - 新增规则：`cannot write` → "写入文件失败"
  - 修复告警条目英文原文重复显示两次的问题

- **其他界面文本**
  - 状态徽章：`OK` → `成功`，`FAIL` → `失败`
  - 连接类型：`SSE` → `实时连接`
  - JDK 来源：`PATH` → `系统环境变量`
  - 错误兜底：`unknown` → `（无错误信息）`

### GitHub 导航按钮
- 顶部工具栏新增 GitHub 图标按钮
- 点击直接跳转到 `https://github.com/jiuyou-7411/dsh-rea-plugin`
- 真实 `<a>` 标签，新标签页打开

## 📸 界面预览

![REA 工作台 v3.0.4](screenshot-v3.0.4.png)

## 🔧 技术细节

- **前端热重载生效**：`client.js` 改动刷新页面即可
- **Host 端需重启**：`lib/error-explain.js` 改动需要重启 DSH
- **工具标签表**：`TOOL_LABELS` 对象集中管理中文映射
- **RankRow 组件升级**：支持双行显示（中文名 + 原始 ID）

## 📦 安装方式

```bash
# 通过 DSH 插件管理器
插件管理 → 安装插件 → 输入：
jiuyou-7411/dsh-rea-plugin

# 或完整 URL
https://github.com/jiuyou-7411/dsh-rea-plugin
```

安装后需**重启 DSH** 使 Host 端改动生效。

## 🙏 致谢

感谢 @用户 提供的真实错误截图，让错误提示规则更准确。

---

**完整变更日志**：[CHANGELOG.md](CHANGELOG.md)  
**问题反馈**：[GitHub Issues](https://github.com/jiuyou-7411/dsh-rea-plugin/issues)
