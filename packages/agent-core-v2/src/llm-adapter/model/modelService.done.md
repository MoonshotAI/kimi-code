# IModelService（modelService）

- v2: `packages/agent-core-v2/src/llm-adapter/model/model.ts`（约 90 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/config/store.ts`（ConfigStore 的 models/default_model 配置节）

## 能力对照

- [x] 模型记录读写（get/list/set/delete/replaceAll/loadAll）→ 模型记录作为 MODELS_CONFIG_SECTION 配置节由 `packages/harness-core/src/features/config/store.ts` 的 ConfigStore get/set 承载，TOML 原子落盘见 `packages/harness-core/src/features/config/persist.ts`
- [x] 默认模型读写（getDefaultModel / setDefaultModel）→ DEFAULT_MODEL_CONFIG_SECTION 配置节 + `packages/harness-core/src/features/provider-catalog/binding.ts` 的 ModelDefaultsRef.setDefaultModel
- [x] 变更事件（onDidChangeModels / onDidChangeDefaultModel）→ 配置节 watch 驱动 `packages/harness-core/src/features/provider-catalog/feature.ts` 的 reconcile，对外经 catalog onChanged 冒泡
- [x] 单条新增模型（v2 set 的产品面）→ ProviderCatalogFace.addModel（feature.ts，走 refresh.ts 的 orchestrator.addModel）
- [x] models.dev 批量导入（v2 无直接对应，属同域能力）→ `packages/harness-core/src/features/models-dev/feature.ts` 的 ModelsDevFace

## 结论

全部对齐：模型注册表由「独立服务」转为「配置节 + provider-catalog 物化」的结构取代，CRUD/默认值/变更通知均有承载。
