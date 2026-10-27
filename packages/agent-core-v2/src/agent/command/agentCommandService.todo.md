# IAgentCommandService（agentCommandService）

- v2: `packages/agent-core-v2/src/agent/command/agentCommand.ts`（约 18 行，读 interface 与 agentCommandService.ts 得出）
- 新架构: 无对应

## 能力对照

- [ ] Agent 作用域命名命令注册表（CommandContribution 贡献、list() 列名/描述/来源、run(name, args) 执行）— 新栈两个包内无通用命名命令注册表；harness-core 的 plugin feature 只有插件命令的列举与参数展开（`packages/harness-core/src/features/plugin/feature.ts` 的 listPluginCommands、`packages/harness-core/src/features/plugin/inspect/commands.ts` 的 expandCommandArguments），激活不走命令注册表。注意 v2 侧该注册表亦无内置生产方（仅 feature.ts 暴露 contributeCommand API，实际调用只在测试与 SDK 桥），属休眠机制
- [ ] 命令面变更通知（onDidChange，贡献增删时触发）— 随注册表一并缺失
- [ ] 对客户端的暴露面（klient `agent.commands()`/`runCommand`，见 `packages/klient/src/core/facade/agent.ts`）— 新栈 feature-http/feature-acp 均无命名命令端点，客户端无入口
- [x] loop 输入命令本身（提交/通知/打断等，线索所指）→ `packages/agent-core/src/loop/create-loop.ts` 的 submit/notify/remind/steer/cancel/continue/abort，但这是引擎命令面，与命名命令注册表是两回事

## 结论

未对齐 1 项——命名命令注册表（含 klient `commands()`/`runCommand` 暴露面）在新栈无承载；鉴于 v2 亦无生产方，按记录在案未迁处理。
