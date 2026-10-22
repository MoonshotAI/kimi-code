# IAgentLifecycleService（agentLifecycleService）

- v2: `packages/agent-core-v2/src/session/agentLifecycle/agentLifecycle.ts`（约 58 行，读 interface 与 agentLifecycleService.ts 得出）
- 新架构: `packages/agent-core/src/session/session.ts` + `packages/harness-core/src/app/session.ts`

## 能力对照

- [x] 创建 agent（create，含 binding/labels）→ `packages/agent-core/src/session/session.ts`（`open` 注册 roster 并绑定 loop 日志）+ `packages/harness-core/src/app/session.ts`（`ensureAgent`，profile 绑定改由 spawn 管线渲染 systemPrompt，labels 的消费方改由 roster `source` 编码承载，如 btw 的 `BTW_SOURCE`）
- [x] fork agent → `packages/agent-core/src/session/session.ts`（`fork` 复制源日志有效记录）+ `packages/harness-core/src/app/session.ts`（`forkAgent`）
- [x] get/list 活动 agent → `packages/agent-core/src/session/session.ts`（`liveAgents` 映射）与 `roster` 投影（`packages/agent-core/src/session/model.ts` 的 `sessionProjection`）
- [x] remove（关闭并移除 agent）→ `packages/agent-core/src/session/session.ts`（`closeAgent`）
- [x] broadcastPermissionMode → `packages/harness-core/src/features/permission/feature.ts`（`PermissionRef.setModeAndBroadcast`）
- [x] 生命周期事件（onDidCreate/onWillClose/onDidClose）→ `packages/harness-core/src/app/units.ts`（Unit 树按 `liveAgents` 响应式挂载/卸载 AgentUnit，Feature 以挂载与 `useCleanup` 承载；externalHooks 经 watch 活动 agent 表派生 SubagentStart/Stop）
- [x] handleOf/adopt/onDidCreateScope（DI scope 句柄）→ 结构消失，由 harness-core Unit 运行时自然承载（`packages/harness-core/src/composition-api/`）

## 结论

全部对齐；DI scope 与显式生命周期事件由 Unit 树生命周期与 roster source 编码结构性替代。
