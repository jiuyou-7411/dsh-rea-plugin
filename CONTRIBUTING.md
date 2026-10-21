# 贡献指南

## 提交前必须跑

```bash
npm run verify
```

它会检查：

- 26 个必需文件是否齐全
- 文档 72 篇、技能 12 个、MobileRE 80 个、DSH 技能 4 个
- 有没有临时脚本、`runs/` 目录混进来
- 有没有硬编码的本地绝对路径

**任何一项失败都不要提交。** 这些检查对应的是真实的打包事故：缺 `vendor/rea-docs/docs` 会让所有文档读取报错，缺 `lib/jdk.js` 会让插件启动崩溃。

## 改 Host 端代码后必须重启

DSH 的 HMR 只热重载前端（`client.js`）。改 `lib/*.js` 或 `index.js` 后：

1. 重启 DSH
2. 确认日志里有 `[rea] host active`

不重启就测试，跑的是旧代码——这已经导致过多次「改了没用」的误判。

## 更新上游内容

```bash
npm run sync:all
```

这条命令做四件事：

1. `sync:rea-skills` — 拉上游 `.agents/skills`，pin 到 commit
2. `sync:doc-index` — 生成 72 篇文档的索引（30 KB）
3. `sync:docs` — 拉文档正文（1.2 MB，离线必需）
4. `build:skills` — 把上游技能转成 DSH 单文件格式

**不要手写 `vendor/` 里的内容**，它会被下次 sync 覆盖。

## 代码约定

**注释写为什么，不写是什么。**

```javascript
// 好：解释了一个不明显的决定
// Windows refuses a rename while any handle to either path is open, and a
// finished fetch body can keep one until it is cancelled.

// 坏：重复代码本身
// Rename the file.
```

**不要静默吞错误。** 失败要么上报，要么说明为什么可以忽略。

**错误信息要说人话。** 面板面向不懂英文的用户，技术细节放次要位置。

## 版本号

语义化版本：

- `3.0.0` — 包名变更、破坏性改动
- `2.9.x` — 修 bug
- `2.x.0` — 加功能

改版本号后必须重新 `npm pack` 并验证。

## 许可

提交的代码按 MIT 授权。
