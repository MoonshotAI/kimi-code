# IBuiltinSkillSource（builtinSkillSource）

- v2: `packages/agent-core-v2/src/features/skill/catalog/builtinSkillSource.ts`（约 62 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/sources/builtin.ts`

## 能力对照

- [x] 内置技能源（id=builtin、优先级 builtin，load 产出当前可见内置技能） → `packages/harness-core/src/features/skill/sources/builtin.ts`（createBuiltinSkillSource）
- [x] 内置技能可见性过滤（builtinProductSkills 配置开关 + 实验 flag 门控个别技能） → `packages/harness-core/src/features/skill/builtin/definitions.ts`（visibleBuiltinSkills）；flag 判定由 IFlagService 变为 `sources/builtin.ts` 的 experimentalFlagEnabled（env 驱动）
- [x] builtinProductSkills 配置段（含 env 绑定 KIMI_CODE_BUILTIN_PRODUCT_SKILLS） → `packages/harness-core/src/features/skill/sources/builtin.ts`（builtinProductSkillsSection）
- [x] 配置变更后本源失效并重载目录（v2 为 config.onDidSectionChange → onDidChange） → `packages/harness-core/src/features/skill/feature.ts`（watch(builtinProduct) 触发 reloadSources([builtin])）

## 结论

全部对齐；DI 服务由 SkillCatalogSource 工厂 + config section 贡献点结构取代。
