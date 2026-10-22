# IAgentAgentsMdReminderService（agentAgentsMdReminderService）

- v2: `packages/agent-core-v2/src/agent/agentsMdReminder/agentsMdReminder.ts`（约 10 行，读 interface 与 agentsMdReminderService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/agentsMdReminder/feature.ts`

## 能力对照

- [x] 启动/恢复时把已注入系统提示词的 AGENTS.md 路径种子化（seedInjected）→ `packages/harness-core/src/features/agentsMdReminder/feature.ts`（AgentsMdReminderRef.seed facade）
- [x] Read/Edit/Write/Glob/Grep/Bash 工具调用后探测目标目录链上未披露的 AGENTS.md 并注入发现提醒 → `packages/harness-core/src/features/agentsMdReminder/feature.ts`（useToolEnding 探测 + agentsMdDiscoveryReminderText）
- [x] Bash 命令经 tree-sitter 解析提取目标目录 → `packages/harness-core/src/features/agentsMdReminder/bash-targets.ts`
- [x] 已种子文件被创建/修改/删除时注入变更提醒（v2 走 instructions watch，新栈改为 step 边界轮询 mtime，能力等价）→ `packages/harness-core/src/features/agentsMdReminder/feature.ts`（useStepStarting 轮询 + agentsMdChangeReminderText）
- [x] 首次把适用于工作区根目录的 AGENTS.md 做初始披露提醒 → `packages/harness-core/src/features/agentsMdReminder/feature.ts`（agentsMdInitialReminderText）

## 结论

全部对齐（发现/变更/初始三类提醒与种子化均已迁移，变更检测由 watch 改为轮询属实现差异；agents_md_reminder_shown 遥测按既定决策不迁，不计入用户可见能力）。
