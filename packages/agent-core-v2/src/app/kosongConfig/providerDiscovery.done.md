# IProviderDiscoveryService（providerDiscovery）

- v2: `packages/agent-core-v2/src/app/kosongConfig/discovery.ts`（约 81 行 interface）
- 新架构: `packages/harness-core/src/features/provider-catalog/refresh.ts`

## 能力对照

- [x] refreshProviderModels（scope all/oauth、可指定 providerId；返回 changed/unchanged/failed/retired_default 报告）→ `packages/harness-core/src/features/provider-catalog/refresh.ts` 的 createRefreshOrchestrator().refresh（ProviderRefreshOptions/ProviderRefreshReport 同构）
- [x] onDidRetireModel 退役模型事件 → refresh.ts 的 RetiredModel + `packages/harness-core/src/features/provider-catalog/feature.ts` 的 onRetiredModel 监听口
- [x] retiredModelReplacement（退役别名替换链查询）→ refresh.ts 的 retiredModelReplacement（含链式跳转）
- [x] event.model_catalog.changed 目录变更事件 → feature.ts 内 fire({ type: 'event.model_catalog.changed', payload })

## 结论

全部对齐——刷新编排、退役替换与变更事件均由 provider-catalog refresh 承载。
