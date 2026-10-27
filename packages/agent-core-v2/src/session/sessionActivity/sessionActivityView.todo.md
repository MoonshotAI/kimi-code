# ISessionActivityView（sessionActivityView）

- v2: `packages/agent-core-v2/src/session/sessionActivity/sessionActivity.ts`（约 36 行，读 interface 得出）
- 新架构: `packages/agent-core/src/session/session.ts`（`Session.status()`）+ `packages/harness-core/src/feature-http/route-features/status.ts`

## 能力对照

- [x] busy/mainTurnActive（活会话忙态切片）→ `packages/agent-core/src/session/session.ts`（`status()` 折叠活 loop 快照；feature-http 侧 `sessionBusy` 还并入 task 运行记录）
- [x] pendingInteraction（approval/question 待交互）→ `packages/harness-core/src/feature-http/route-features/status.ts`（`sessionPendingInteraction`，读 interaction 相关 facade）
- [x] lastTurnReason（活会话/重开会话）→ `packages/agent-core/src/session/session.ts`（`status().lastTurnReason` 来自 lastTurn 索引，重开时由 catalog record 载入）
- [x] 状态变更通知（onDidChange/cause）→ `packages/harness-core/src/feature-http/ws-v1/sessionState.ts`（`agent.status.updated` 推送；HTTP 侧为按需读取）
- [ ] 冷会话（未打开）lastTurnReason — 降级：冷会话不打开则无法调用 `status()`；`route-v2/sessions.ts` 对非活会话只回退到 sessionIndex 扫描的 `last_turn_outcome`（仅参与 failed 判定），通用的只读 replay 取 lastTurnReason 未做

## 结论

未对齐 1 项——冷会话 lastTurnReason 不可得（仅有 sessionIndex 扫描回退，只读 replay 未做）。
