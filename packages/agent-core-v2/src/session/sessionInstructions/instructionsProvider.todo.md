# ISessionInstructionsProvider（sessionInstructionsProvider）

- v2: `packages/agent-core-v2/src/session/sessionInstructions/instructionsProvider.ts`（约 23 行，读 interface 与消费方 profileService/trustDisclosureService 得出）
- 新架构: `packages/harness-core/src/features/agentsMdReminder/feature.ts`

## 能力对照

- [x] AGENTS.md 路径披露与变更提醒（agentsMdPaths + onDidChange 文件监听）→ `packages/harness-core/src/features/agentsMdReminder/feature.ts`（初始/发现/变更三路 reminder 指路；`AgentsMdReminderRef.seed`）——v2 的 watch 变更事件由 change reminder 承载
- [x] 工具访问路径触发的 AGENTS.md 发现（v2 由 agentsMdReminderService 消费本服务）→ 同文件（`useToolEnding` 从已完成工具调用的路径发现未披露 AGENTS.md）
- [ ] AGENTS.md 内容注入 system prompt（agentsMd 文本，经 profile 模板 `agents_md` 渲染）— 决策不做：新栈明确「AGENTS.md 内容永不进入 system prompt」（见 `packages/harness-core/src/features/agentsMdReminder/AGENTS.md`），改为 reminder 指向路径让 agent 自读；`packages/harness-core/src/features/profiles/` 渲染上下文无 `agents_md` 字段
- [ ] agentsMdWarning（读取警告随 trust 披露上浮）— 未迁：新栈 agentsMdReminder 无 warning 面，trust 披露流程未迁移

## 结论

未对齐 2 项——内容注入 prompt 为明确决策不做（改指路式 reminder），读取警告上浮未迁移。
