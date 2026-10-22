# ISessionSubagentScopeCacheService（sessionSubagentScopeCacheService）

- v2: `packages/agent-core-v2/src/session/subagent/subagentScopeCache.ts`（约 49 行；interface 为空，能力读实现 subagentScopeCacheService.ts 约 199 行得出）
- 新架构: `packages/harness-core/src/app/session.ts`（`ensureAgent`）+ Unit 树生命周期

## 能力对照

- [x] 完成的子 agent 可低成本 resume（缓存活 scope，resume 直接复用）→ `packages/harness-core/src/app/session.ts`（`ensureAgent` 对活 agent 幂等返回，对关闭 agent 从持久日志重开）；`packages/harness-core/src/features/spawn/run.ts` 的 `resume` 即走此路——重开能力比 v2 更强（必然可恢复，不依赖缓存命中）
- [x] 关闭/踢出时的生命周期收尾（v2 经 onWillClose/onDidClose 跟踪）→ `packages/harness-core/src/app/units.ts`（Unit 树按 liveAgents 响应式挂载卸载，`useCleanup` 收尾）

说明：v2 的 LRU 容量/驱逐超时（KIMI_CODE_SUBAGENT_SCOPE_CACHE_SIZE=32、15s 超时）是内存治理策略，新栈无对应（活 agent 集合不设上限）；该策略对用户不可见，resume 能力本身由持久重开承载。

## 结论

全部对齐；scope 缓存概念由 Unit 树生命周期与持久重开自然承载，LRU 驱逐策略不迁（记录在案，非用户可见能力）。
