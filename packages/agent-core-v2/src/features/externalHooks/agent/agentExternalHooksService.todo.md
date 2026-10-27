# IAgentExternalHooksService（agentExternalHooksService）

- v2: `packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooks.ts`（接口约 8 行 brand-only；实现 `agentExternalHooksService.ts` 约 472 行，能力读实现得出）
- 新架构: `packages/harness-core/src/features/externalHooks/feature.ts`（agent slot）

## 能力对照

- [x] PreToolUse 阻塞钩子（命中 block 即拒绝工具执行并回传 reason）→ `packages/harness-core/src/features/externalHooks/feature.ts`（`useToolStarting` + `triggerBlock`）
- [x] PostToolUse/PostToolUseFailure（按成败分流，携带 toolInput/toolOutput 截断 2000 字符/error）→ 同文件 `useToolEnding`
- [x] UserPromptSubmit：block 时阻断该 prompt（step 起点拦截），通过时把 hook 输出以 XML 追加进用户消息 → 同文件 `useMessageAppending` + `internal/userPrompt.ts` 渲染
- [x] Stop 阻塞钩子与 stop_hook 续轮（阻塞理由作为 `stop_hook` origin 的 notify 继续 turn，每轮一次）→ 同文件 `useStepStopping`
- [x] StopFailure（turn 失败与 MAX_STEPS 两路）、Interrupt（aborted）、UserPromptQueued、TurnStarted（origin kind/name 与可展示 prompt）→ 同文件 `useLoopEvent` 各分支
- [x] TaskStarted（detached 任务开始）、PermissionRequest/PermissionResult、PreCompact/PostCompact → 同文件 `useOn('task.started' | 'permission.*' | 'compaction.*')`
- [ ] Notification 事件未接线 — v2 由后台任务通知（`IAgentTaskService` 的 notification 钩子）触发 `Notification` hook；新栈 20 个事件中 19 个已接线，独缺 Notification（task feature 的通知回调未接 hook 触发）

## 结论

未对齐 1 项——Notification 事件未接线；agent 侧其余 15 类 hook 触发（含阻塞与续轮语义）均已迁移。
