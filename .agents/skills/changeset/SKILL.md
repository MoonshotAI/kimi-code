---
name: changeset
description: 在 code-app 仓库写 changeset（发版说明）时使用：判断要不要写、版本级别怎么选、如何写一句面向用户的中文描述。
---

# 写 Changeset

code-app 用 changesets 管理桌面端（`kimi-code-app`）的版本与发版。功能 PR 里只要有用户能感知的变化，就附一个 `.changeset/*.md` 文件一起提交；合入 main 后 CI 会自动汇总出版本 PR。

只有 `kimi-code-app` 参与发版，changeset 的 frontmatter 只允许出现 `kimi-code-app`。本仓其余包（`kimi-code-web`、`@moonshot-ai/web-*` 等）在 `.changeset/config.json` 的 `ignore` 里；kimi-code submodule 的包**不在** ignore 里（release CI 不 checkout submodule，而 ignore 要求包真实存在于 workspace），跑 `pnpm changeset` 时列表里会看到它们——**严禁选择**，选了 CI 的 `changeset version` 会直接失败。注意 desktop 运行时打包了 `packages/web-*` 和 kimi-code submodule 的源码（`kap-server`、`agent-core-v2` 等），这些改动只要用户能感知，也算 `kimi-code-app` 的变化，同样要写。

## 什么时候要写

- 要写：修 bug、新功能、界面 / 交互 / 快捷键调整、性能或稳定性改进——任何用户能感觉到的不一样。
- 不写：纯测试、内部重构、文档、CI、开发工具等用户感知不到的改动。

## 版本级别：早期阶段只用 patch

**当前处于早期阶段，一律写 `patch`，不要写 `minor` 或 `major`，新功能也一样。** 如果你觉得某个改动值得更高级别，先停下来和用户确认。

## 怎么写

在仓库根目录跑 `pnpm changeset` 按提示生成，或直接手写一个 `.changeset/<kebab-case 名>.md`：

```markdown
---
"kimi-code-app": patch
---

修复发送消息后聊天不滚动到底部的问题。
```

一个 changeset 只写一件事；不相关的改动拆成多个文件。

## 描述怎么写

面向最终用户写**一句简短的中文**，说清"用户得到或修复了什么"，不要技术细节：

- **只写一句话。** bug 修复写到"修复了什么问题"就停，不要追加"现在会……"的行为补充（修复后的正常行为是默认预期，写出来是废话）。
- 写用户能看到的结果，不写实现：不出现文件名、类名、函数名、内部包名、PR 号。
- 新功能可以顺手带半句怎么用，如"在设置里开启"（同一句话内）。
- 避免"优化""改进""重构"这类空话，写清具体是什么变化。

好的例子：

- `修复长对话中工具调用结果偶尔丢失的问题。`
- `修复窗口全屏时点击关闭按钮变成全黑屏幕的问题。`
- `支持系统原生目录选择器，选择工作目录更方便。`
- `启动失败时展示错误页，一键复制错误信息。`

坏的例子：

- `修复窗口全屏时点击关闭按钮变成全黑屏幕的问题，现在会先退出全屏再正常隐藏窗口。（后半句是多余的"现在会……"补充，删掉）`
- `优化会话管理的性能。（空话，看不出变了什么）`
- `重构 loadSessions 方法支持分页。（内部实现，用户看不见）`

## 红旗

- 准备写 `minor` / `major`（早期阶段只允许 `patch`）。
- 描述不是中文，或超过一句话。
- 描述里出现文件名、内部包名、PR 号等技术细节。
- 给纯测试 / 文档 / 重构改动写了 changeset。
- frontmatter 里出现 `kimi-code-app` 以外的包（`pnpm changeset` 列表里能看到 kimi-code submodule 的包，一个都不能选）。
