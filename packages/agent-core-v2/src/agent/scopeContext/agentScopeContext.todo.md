# IAgentScopeContext（agentScopeContext）

- v2: `packages/agent-core-v2/src/agent/scopeContext/scopeContext.ts`（约 55 行，interface 与工厂同文件）
- 新架构: `packages/harness-core/src/composition-api/runtime.ts`（EventContext）+ `packages/agent-core/src/session/session.ts`

## 能力对照

- [x] agent 身份（agentId）→ `packages/agent-core/src/session/` 的 `Agent.id`；事件面由 `packages/harness-core/src/app/units.ts` 向 `EventContext` 贡献 agentId/sessionId（kernel 在 deliver 时富化到每个 RuntimeEvent）
- [x] fork 谱系（forkedFrom）→ `packages/agent-core/src/session/model.ts` 的 `AgentInfo.forkedFrom`（`session.fork` 注册时落 roster 事件）
- [x] 作用域键命名（scope(subKey)，用于状态键/存储前缀隔离）→ feature 持久化日志按 `agents/<agentId>/<name>` 命名，见 `packages/harness-core/src/runtime/stores.ts` 的 useFeatureStore；feature 贡献面取 agent 上下文经 `packages/harness-core/src/composition-api/` 的 useInject/useAgent
- [ ] agentContext 的 generation 与 AgentSpace 载体 — generation 属 v2 runtime 代数体系（决策不迁），AgentSpace 的按上下文缓存实例功能由 kernel Unit 树生命周期吸收，不作为独立能力保留

## 结论

未对齐 1 项——agent 身份/fork 谱系/作用域隔离已对齐；agentContext 中的 generation 随 runtime 体系决策不迁（AgentSpace 由 Unit 树吸收）。
