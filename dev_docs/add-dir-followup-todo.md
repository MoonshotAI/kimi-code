# add-dir 后续 TODO

本文记录 `/add-dir` 相关功能的后续待办。前置调研见 `dev_docs/add-dir-local-command-stdout-research.md`。

## TODO 1：包装 `<local-command-stdout>`，不进入消息流

### 目标

`/add-dir` 成功后，向当前 session 插入一条 user 角色的 `<local-command-stdout>` 消息，但：

- 不启动 turn
- 不立刻发给 AI
- 不出现在 live 消息流
- 不出现在 resume 后的 transcript
- 仍然进入模型上下文

### 需要做的事

- 新增 core RPC 方法，例如 `appendLocalCommandStdout`
- 在 core agent context 中实现同名方法
- 内容包装为：

```xml
<local-command-stdout>
...
</local-command-stdout>
```

- origin 使用内部 injection 类型，例如：

```ts
{ kind: 'injection', variant: 'local-command-stdout' }
```

- `/add-dir` 成功后调用该方法
- 移除当前临时加入的 transcript 可见入口
- `--add-dir` / resume flag 不插入该消息

### 验收标准

- `/add-dir` 成功后写入一条 user role record
- record 内容为 `<local-command-stdout>...</local-command-stdout>`
- origin 为内部 injection 类型
- TUI transcript 不显示该消息
- resume 后 transcript 不显示该消息
- 下一轮用户发消息时，该记录会作为上下文发送给模型

## TODO 2：slash 文件补全优化，支持连续 Tab 显示补全列表

### 目标

优化 slash command 中的文件/路径补全体验，特别是 `/add-dir <path>` 这类场景。

当前问题：

- 文件补全不支持连续 Tab 显示补全列表
- 用户需要记住路径或手动输入完整路径
- 补全交互不如普通 shell 顺手

### 需要做的事

- 梳理当前 slash command 的文件补全入口
- 确认补全逻辑是复用 file mention provider，还是独立实现
- 支持连续 Tab 触发补全列表展示
- 支持目录/文件候选展示
- 支持选择后回填到输入框
- 处理目录结尾 `/` 与继续补全子目录

### 验收标准

- 输入 `/add-dir ` 后按 Tab 可以显示候选列表
- 连续按 Tab 可以浏览/切换候选
- 选择目录后可以继续补全子目录
- 选择文件/目录后正确回填
- 不影响普通 `@` 文件提及补全

## TODO 3：支持显示 hint

### 目标

slash command / 补全列表中支持显示 hint，帮助用户理解每个选项的含义。

当前问题：

- 补全项缺少说明
- 用户无法从列表中判断选项作用
- 对 `/add-dir` 这种涉及 session-only / remember 的交互尤其需要 hint

### 需要做的事

- 梳理当前补全/选择组件的数据结构
- 为候选项增加 hint 字段
- UI 支持展示 hint
- 对 `/add-dir` 的选项补充明确 hint，例如：
  - `Yes, for this session` → session-only，不写入 local config
  - `Yes, and remember this directory` → 写入 `.kimi-code/local.toml`
  - `No` → 取消添加

### 验收标准

- slash command 选项可以展示 hint
- 补全列表可以展示 hint
- hint 文案清晰，不超出 UI 宽度
- 不影响现有选择/确认交互

## 优先级建议

1. TODO 1：`<local-command-stdout>` 包装与隐藏  
   这是当前 `/add-dir` 行为收尾，依赖调研结论，优先级最高。

2. TODO 3：hint 显示  
   与 `/add-dir` 选择项体验直接相关，可以较早做。

3. TODO 2：连续 Tab 文件补全  
   依赖补全组件梳理，改动可能更大，可以放在 TODO 1 / TODO 3 之后。
