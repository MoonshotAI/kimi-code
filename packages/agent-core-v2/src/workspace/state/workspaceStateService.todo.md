# IWorkspaceStateService（workspaceStateService）

- v2: `packages/agent-core-v2/src/workspace/state/workspaceState.ts`（约 9 行，interface 即 IStateRegistry，读 `_base/state/stateRegistry.ts` 实现得出）
- 新架构: `packages/agent-core/src/store/`（事件溯源 Journal + Projection）+ `packages/harness-core/src/runtime/stores.ts`（useFeatureStore）

## 能力对照

- [x] 工作区级键值状态的注册/读写（contributeState/get/set）→ 结构性替代：持久状态折叠进 `packages/agent-core/src/store/` 的 Projection（如 workspacesProjection），瞬态状态用 kernel 的响应式 ref
- [x] 按 key 的变更订阅（onDidChange/onDidChangeAny）→ `packages/harness-core/src/runtime/stores.ts` 的 useFeatureStore 与 kernel ShallowRef 订阅（如 workspaces feature 的 state）
- [ ] 通用 StateKey 注册中心形态（任意模块向 workspace 贡献命名状态）— 无对应：新栈状态按 feature 各自持有，无跨模块共享的键值注册表（决策：投影体系取代）
- [ ] snapshot()/inspect() 的 JSON 化状态自检层级（调试面板用）— 未见等价（kimi-inspect 的 Service 状态面板属 v2 DI 体系）

## 结论

未对齐 2 项——状态的承载与订阅已由 store 投影 + kernel 响应式体系接管；通用注册表形态与 snapshot/inspect 调试自检未迁。
