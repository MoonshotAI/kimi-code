# IModelsDevImportService（modelsDevImport）

- v2: `packages/agent-core-v2/src/app/kosongConfig/modelsDevImport.ts`（约 65 行 interface）
- 新架构: `packages/harness-core/src/features/models-dev/feature.ts`

## 能力对照

- [x] listModelsDevProviders/getModelsDevProvider（浏览 models.dev 目录，含 wire 类型猜测与拒绝原因）→ service.ts 的 listProviders/getProvider（models-dev.ts toModelsDevProviderItem）
- [x] importModelsDevProvider（导入 provider 与模型写配置、OAuth 托管保护、首模型置默认）→ service.ts 的 importProvider（含 seedDefaultModelWhenUnset）
- [x] importCustomRegistry（自定义 registry 导入、按 source url 清理旧条目、失效默认清理）→ service.ts 的 importRegistry + writeRegistrySections
- [x] models.dev 源 refresh 通道 → service.ts 的 refreshProvider + refreshRegistries（接 provider-catalog 刷新编排）

## 结论

全部对齐——models.dev 浏览/导入与自定义 registry 导入均由 models-dev feature 承载。
