# IProviderService（providerService）

- v2: `packages/agent-core-v2/src/llm-adapter/provider/provider.ts`（约 58 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/config/store.ts`（providers 配置节）+ `packages/harness-core/src/features/provider-catalog/feature.ts`

## 能力对照

- [x] provider 配置读写（get/list/set/delete/replaceAll/loadAll，含 baseUrl/customHeaders/oauth/env 等）→ PROVIDERS_CONFIG_SECTION 配置节由 `packages/harness-core/src/features/config/store.ts` 的 ConfigStore get/set 承载
- [x] 默认 provider（getDefaultProvider / setDefaultProvider）→ DEFAULT_PROVIDER_CONFIG_SECTION 配置节（provider-catalog feature.ts 的 useConfigSection(defaultProviderConfigSection)）
- [x] 变更事件（onDidChangeProviders / onDidChangeDefaultProvider）→ 配置节 watch 驱动 `packages/harness-core/src/features/provider-catalog/feature.ts` 的 reconcile，对外经 catalog onChanged 冒泡
- [x] 运行时新增 provider（含 init 落盘）→ ProviderCatalogFace.addProvider（feature.ts，Providers 集合注册 + 写 PROVIDERS_CONFIG_SECTION）
- [x] models.dev / 自定义注册表导入 provider（v2 的 modelSource 发现面）→ `packages/harness-core/src/features/models-dev/feature.ts` 的 ModelsDevFace（importProviders/importCustomRegistry）

## 结论

全部对齐：provider 注册表由「独立服务」转为「配置节 + provider-catalog 贡献装配」的结构取代，CRUD/默认值/变更通知/导入均有承载。
