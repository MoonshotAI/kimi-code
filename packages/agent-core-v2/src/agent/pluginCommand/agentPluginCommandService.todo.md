# IAgentPluginCommandService（agentPluginCommandService）

- v2: `packages/agent-core-v2/src/agent/pluginCommand/pluginCommand.ts`（约 37 行，读 interface 与 pluginCommandService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/plugin/face.ts`（仅目录面，执行未接线）

## 能力对照

- [x] 插件命令目录（listPluginCommands 列出启用插件的命令定义）→ `packages/harness-core/src/features/plugin/face.ts`（PluginFace.listPluginCommands）+ `packages/harness-core/src/features/plugin/state/manager.ts`（enabledCommands）
- [x] 命令体参数展开（expandCommandArguments）→ `packages/harness-core/src/features/plugin/inspect/commands.ts`
- [ ] activate：slash 触发后展开命令体并以 user 消息提交进 loop（带 plugin_command origin、tracked 元数据）— 新栈无消费方：skill feature 与 feature-acp 均未接线 listPluginCommands/expandCommandArguments 的执行路径
- [ ] PluginCommandActivated 可观测事件（plugin_command.activated）— 随执行路径一并未迁
- [ ] main agent 的 prompt metadata 更新（lastPrompt 写入 /plugin:command 文本）— 随执行路径一并未迁

## 结论

未对齐 3 项——命令目录与参数展开函数在案，但 slash 执行、激活事件与 prompt metadata 更新均无承载。
