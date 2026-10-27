# IAgentConversationUndoService（agentConversationUndoService）

- v2: `packages/agent-core-v2/src/agent/undo/undo.ts`（约 16 行，读 interface 与 undoService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/undo/feature.ts`

## 能力对照

- [x] availability：可回退 turn 数与是否止于 compaction 边界 → `packages/harness-core/src/features/undo/anchors.ts`（computeUndoAvailability，UndoAvailability 同形）
- [x] undo(turns)：空闲门控、串行队列、按锚点切割、重挂会话、context.undone 事件与 conversation_undo 遥测 → `packages/harness-core/src/features/undo/feature.ts`（UndoRef.undo）+ `packages/harness-core/src/features/undo/anchors.ts`（planUndoCut）+ `packages/harness-core/src/runtime/stores.ts`（undoAgentTurns）
- [ ] participants 注册表的 undo 后 reconcile（v2 经 IAgentConversationUndoParticipantRegistry 两阶段回调）— 不迁
- [ ] main agent 的 lastPrompt reconcile（回退后重写会话元数据 lastPrompt 并发 SessionMetaUpdated）— 不迁
- [ ] 切割粒度差异：v2 为消息粒度切割，新栈为 turn 粒度（planUndoCut 按 machineTurns）— 差异记录在案

## 结论

未对齐 3 项——回退主流程（可用性、切割、重挂、事件）已迁移；participants reconcile、lastPrompt reconcile 不迁，粒度差异在案。
