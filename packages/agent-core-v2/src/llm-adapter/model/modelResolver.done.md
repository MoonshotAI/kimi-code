# IModelCatalog（modelResolver）

- v2: `packages/agent-core-v2/src/llm-adapter/model/catalog.ts`（约 213 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/provider-catalog/feature.ts`（ProviderCatalogFace）

## 能力对照

- [x] 按 id 取模型与请求器（get / getRequester）→ ProviderCatalogFace.model()/requester()（feature.ts），requester 由 `packages/agent-core/src/llm/catalog/catalog.ts` 的 buildModelRequester 逐层 with 装配
- [x] 流式生成（generate）→ `packages/agent-core/src/llm/requester.ts` 的 LlmRequester.generate
- [x] 连通性探测（ping）→ ProviderCatalogFace.ping → `packages/agent-core/src/llm/catalog/catalog.ts` 的 ping 队列（含凭据失效重试）
- [x] 按名称反查（findByName）→ ProviderCatalogFace.findByName
- [x] 目录枚举 REST 面（listModels / listProviders / getProvider）→ `packages/harness-core/src/feature-http/route-builtin/model-catalog.ts`（providers.list/get/create/replace 等路由）+ `packages/harness-core/src/feature-acp/model-catalog.ts` 的 projectModelCatalog
- [x] 设默认模型（setDefaultModel）→ `packages/harness-core/src/features/provider-catalog/binding.ts` 的 ModelDefaultsRef.setDefaultModel（写 DEFAULT_MODEL_CONFIG_SECTION）

## 结论

全部对齐：模型解析/生成/ping/目录枚举/默认模型各项能力分别由 provider-catalog facade、agent-core requester 与 feature-http/feature-acp 的目录面承载。
