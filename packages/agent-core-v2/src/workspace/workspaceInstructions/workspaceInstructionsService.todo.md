# IWorkspaceInstructionsService（workspaceInstructionsService）

- v2: `packages/agent-core-v2/src/workspace/workspaceInstructions/workspaceInstructions.ts`（约 23 行，读 interface 与 workspaceInstructionsService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/agentsMdReminder/`（reminder 体系）

## 能力对照

- [x] AGENTS.md 发现（工作区根 + 工具访问路径逐级向上）并告知 agent → `packages/harness-core/src/features/agentsMdReminder/feature.ts` 的初始披露与 discovery reminder（loop.remind）
- [x] AGENTS.md 磁盘变更（创建/修改/删除）感知并提示 → 同文件 change reminder（step 边界 mtime 轮询，替代 v2 的 fswatch+防抖）
- [ ] AGENTS.md 内容拼接后注入系统提示（v2 snapshot.agentsMd 经 sessionProvider 进入 ISessionInstructionsProvider）— 决策不做：新栈明示内容永不进入系统提示（features/agentsMdReminder/AGENTS.md），改为路径 reminder 让 agent 自读
- [ ] workspace 级 snapshot（agentsMd/agentsMdWarning/agentsMdPaths）与 onDidChange 对外订阅 — 无对应：簿记下沉为 per-agent 内存（known/flushed/disclosed 集合），无 facade 暴露快照、无变更事件流；agentsMdWarning（内容异常警告）亦无等价
- [ ] reload() 主动重载 — 无对应（初始披露一次完成，后续靠 step 边界轮询）

## 结论

未对齐 3 项——发现/变更提醒能力对齐；「内容入系统提示」为明确决策不做，workspace 级快照/事件/reload 形态无承载。
