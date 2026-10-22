# IProtocolAdapterRegistry（protocolAdapterRegistry）

- v2: `packages/agent-core-v2/src/llm-adapter/protocol/protocol.ts`（约 57 行，读 interface 得出）
- 新架构: `packages/agent-core/src/llm/protocol/protocol.ts`（defineProtocol 协议机制）

## 能力对照

- [x] 受支持协议枚举（supportedProtocols：anthropic/openai/openai_responses/google-genai）→ `packages/agent-core/src/llm/builtin/`（内置 protocol/provider 模块）+ `packages/harness-core/src/features/provider-catalog/feature.ts` 的 ProviderProtocols 集合（开放协议名，贡献式装配）
- [x] 协议适配身份解析（resolveAdapterIdentity / resolveProviderBaseId）→ 结构取代：各 protocol requester 模块自带身份与默认头，经 useProviderProtocol 按 provider type 装配（feature.ts 内 openai/openai_responses/anthropic/google-genai/vertexai 五组默认装配）
- [x] 能力解析（resolveCapability）→ 结构取代：能力改为模型声明式，`packages/agent-core/src/llm/catalog/types.ts` 的 CatalogModelDefinition.capability + `packages/agent-core/src/llm/request.ts` 的 capabilityAccepts
- [x] 模型请求器解析（resolve(model)）→ `packages/agent-core/src/llm/catalog/catalog.ts` 的 buildModelRequester（endpoint/协议选项/模型 spec 逐层 with）+ provider-catalog 的 materializeProvider

## 结论

全部对齐：注册表式协议解析被「agent-core 开放协议机制 + provider-catalog 贡献装配」取代，标准四家协议默认装配备齐。
