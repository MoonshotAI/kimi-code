# IProviderCatalogRuntime（providerCatalogRuntime）

- v2: `packages/agent-core-v2/src/llm-adapter/model/catalog-runtime.ts`（约 259 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/provider-catalog/feature.ts`（ProviderCatalogFace + reconcile 装配）

## 能力对照

- [x] provider/模型配置变更后增量同步物化目录（sync/resync + upsertEntry/remove）→ `packages/harness-core/src/features/provider-catalog/feature.ts` 的 reconcile（watch 配置节与贡献集合后 cat.upsert/remove），底层引擎为 `packages/agent-core/src/llm/catalog/catalog.ts` 的 createProviderCatalog
- [x] 别名列举与查询（aliases() / lookup(alias)）→ `packages/harness-core/src/features/provider-catalog/binding.ts` 的 matchCatalogBinding + types.ts 的 catalogModelAlias
- [x] provider 列举与信息查询（providerIds() / providerInfo()）→ ProviderCatalogFace.providers()/providerInfo()（feature.ts）
- [x] 目录变更通知（onChanged）→ `packages/agent-core/src/llm/catalog/catalog.ts` 的 onChanged + ProviderCatalogFace.onChanged
- [x] 在线发现刷新（v2 由 catalog sync 引擎承担）→ `packages/harness-core/src/features/provider-catalog/refresh.ts` 的 createRefreshOrchestrator（refresh 队列/失败与退役事件）

## 结论

全部对齐：v2 的「配置→目录物化」运行时由 agent-core catalog 引擎 + harness-core provider-catalog feature 的 reconcile/refresh 双层结构完整承载。
