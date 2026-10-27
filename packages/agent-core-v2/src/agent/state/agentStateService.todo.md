# IAgentStateService（agentStateService）

- v2: `packages/agent-core-v2/src/agent/state/agentState.ts`（约 18 行，读 interface 与 `packages/agent-core-v2/src/_base/state/stateRegistry.ts` 得出）
- 新架构: `packages/harness-core/src/runtime/stores.ts`（useFeatureStore）+ `packages/agent-core/src/store/`

## 能力对照

- [x] 按贡献注册的键值状态（contributeState/get/set/onDidChange），变更经事件落库 → `packages/harness-core/src/runtime/stores.ts` 的 `useFeatureStore`：projection 折叠、dispatch 落事件、`state` 响应式可读、agent/session 两级作用域
- [x] 状态可重放（replayable 键随事件流重建）→ 新栈天然满足：feature 状态即 `packages/agent-core/src/store/` 日志的 replica view（`replica.ts` 的 `view(projection)`），重开即重放
- [ ] 可重放键的动态注册表（replayableKeys/onDidContributeReplayable/onDidWithdrawReplayable，供 replayBuilder 枚举）— 新栈无中央注册表，重放以日志为单位而非键为单位，机制未迁（v2 注册表主要服务 replay/调试面）
- [ ] 状态快照与检查面（IStateRegistry.snapshot/inspect，kap-server /debug 与 kimi-inspect 消费）— 归属 kap-server 宿主层的调试反射面，新栈两个包内无对应，记录在案未迁

## 结论

未对齐 2 项——durable 键值状态与重放能力已由 feature store + 日志投影对齐；可重放键注册表与 snapshot/inspect 调试反射面未迁。
