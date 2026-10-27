# ITaskStopTool（taskStopTool）

- v2: `packages/agent-core-v2/src/agent/tools/task/task-stop/task-stop.ts`（约 18 行；实现 taskStopTool.ts 约 72 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/task/tools/task-stop.ts`

## 能力对照

- [x] 停止运行中的后台任务（理由记录、默认理由 "Stopped by TaskStop"、终态幂等回报）→ `packages/harness-core/src/features/task/tools/task-stop.ts`、`feature.ts`（loop.abortTool）
- [x] 审批规则（按 task_id 做 glob 匹配）→ `packages/harness-core/src/features/permission/language/tool-matchers.ts`（TaskStop 条目）
- [x] :detach 宿主动作 → `packages/harness-core/src/feature-http/route-features/task.ts` + `packages/harness-core/src/features/task/feature.ts`（TaskRef.detach；仅对已后台任务生效，前台转后台未接线——见 bashTool.md / subagentTool.md）
- [ ] 停止后的完成通知抑制（v2 suppressTerminalNotification：TaskStop 主动停止后不再向 agent 推送该任务的完成通知）— 未迁：新栈被停任务仍经 tool.async_ended 落通知
- [ ] Wall time 显示 — 降级：新栈回报只有 task_id/status/reason

## 结论

未对齐 2 项——完成通知抑制未迁、Wall time 降级；停止主能力与 :detach 宿主面已对齐。
