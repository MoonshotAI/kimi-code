# IAppStateService（appStateService）

- v2: `packages/agent-core-v2/src/app/state/appState.ts`（约 9 行 interface；能力在 `packages/agent-core-v2/src/_base/state/stateRegistry.ts` 约 163 行，读过）
- 新架构: `packages/harness-core/src/runtime/stores.ts`（useFeatureStore 投影）

## 能力对照

- [x] 应用级通用状态容器（contributeState/get/set/onDidChange 变更事件）→ 结构性替代：runtime/stores.ts 的 useFeatureStore，各 feature 以事件溯源投影持有状态（如 workspaces、sessionIndex、provider-catalog）
- [x] 作为 workspace/session 级状态注册表的父级（inspectParent 链）→ 结构性替代：app/session/agent 三级 feature store（runtime/stores.ts 的 scope 维度）
- [ ] snapshot()/inspect() 跨 scope 状态检视链（含 snapshotExcluded，供调试面板与 state-manifest）— 未迁：新栈无统一状态检视面；v2 侧该面仅服务调试工具链（kimi-inspect、scripts/gen-state-manifest.mts），属决策性简化

## 结论

未对齐 1 项——状态持有机制已由 store 投影承载；统一检视/快照面未迁（决策性简化）。
