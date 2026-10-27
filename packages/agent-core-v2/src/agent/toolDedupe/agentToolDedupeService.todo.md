# IAgentToolDedupeService（agentToolDedupeService）

- v2: `packages/agent-core-v2/src/agent/toolDedupe/toolDedupe.ts`（约 25 行，读 interface 与 toolDedupeService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/toolDedupe/feature.ts`

## 能力对照

- [x] 同步内同参工具调用去重（同 key 后续调用等首个结果）→ `packages/harness-core/src/features/toolDedupe/feature.ts`（useToolStarting 的 stepDeferreds 机制）
- [x] 连续重复调用的三级提醒与 12 次强制停（repeat breaker）→ `packages/harness-core/src/features/toolDedupe/feature.ts`（REMINDER_TEXT_1/2/3、REPEAT_* 阈值、HANDOFF_VETO_TEXT 逐字对应）
- [x] 强停后交接（handoff 阶段 veto 后续工具调用、补一轮纯文本 notify）→ `packages/harness-core/src/features/toolDedupe/feature.ts`（handoffPhase 状态机 + queueMicrotask notify）
- [x] 四类遥测事件（tool_call_repeat / turn_repeat / dedup_detected / repeat_handoff）→ `packages/harness-core/src/features/toolDedupe/feature.ts`（useTelemetryEvents 注册）
- [ ] 强停交接的 bypassMaxSteps 标记（v2 loop.notify 携带）— 新栈 notify 通路无此面，未迁
- [ ] spill.suffix 追加提醒与 stopTurnReason='repeat_breaker' 结果面 — 新栈 ToolResult 只有 stopTurn 布尔，无 stopTurnReason/spill.suffix，未迁
- [ ] tool_call 上的 dup_type 标记（v2 经 toolExecutor.recordDupType 记录到调用本身）— 新栈仅遥测，调用条目无标记，未迁
- [ ] 遥测事件中的 trace_id 字段 — 新栈 hook 输入与事件定义均不含 trace_id，未迁

## 结论

未对齐 4 项——去重与 repeat breaker 主体（约 390 行）已迁移；bypassMaxSteps、spill.suffix/stopTurnReason、dup_type 标记与 trace_id 四个侧面未迁。
