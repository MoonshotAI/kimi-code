# IConfigRegistry（configRegistry）

- v2: `packages/agent-core-v2/src/app/config/config.ts`（约 224 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/config/feature.ts`（ConfigSections/ConfigOverlays collections）+ `packages/harness-core/src/features/config/store.ts`

## 能力对照

- [x] registerSection/unregisterSection（schema/defaultValue/merge/env/stripEnv/fromToml/toToml/deprecations/collectDiagnostics 选项）→ `useConfigSection` 贡献 + store.syncSections 响应式增删（feature.ts、store.ts 的 ConfigSectionContribution）
- [x] getSection/listSections → ConfigSections collection（`useCollection(ConfigSections)`，feature.ts）
- [x] registerEffectiveOverlay/listEffectiveOverlays → `useConfigOverlay` / ConfigOverlays collection + store.syncOverlays（feature.ts、store.ts 的 ConfigOverlayContribution.apply/strip）
- [x] validate/merge/defaultValue → section 贡献上的 schema/merge/defaultValue 由 store 内部应用（store.ts）
- [x] 注册/注销/overlay 注册事件（v2 onDidRegisterSection/onDidUnregisterSection/onDidRegisterOverlay）→ 响应式 watch（feature.ts 中 watch(contributed)/watch(contributedOverlays)）
- [x] 磁盘格式 snake_case 双向转换 → `packages/harness-core/src/features/config/toml.ts`（camelToSnake/snakeToCamel、transformTomlData）

## 结论

全部对齐——注册表由 DI 服务转为「collection 贡献 + 响应式同步进 store」结构，section/overlay 两类扩展点与校验合并语义完整保留。
