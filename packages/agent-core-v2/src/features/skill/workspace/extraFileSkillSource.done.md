# IExtraFileSkillSource（extraFileSkillSource）

- v2: `packages/agent-core-v2/src/features/skill/workspace/extraFileSkillSource.ts`（约 56 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/sources/files.ts`

## 能力对照

- [x] 附加技能目录源（id=extra、优先级 extra）：扫描 extraSkillDirs 配置目录 → `packages/harness-core/src/features/skill/sources/files.ts`（createExtraSkillSource）
- [x] extraSkillDirs 配置段注册 → 同文件（extraSkillDirsSection）
- [x] 配置变更后本源失效重载 → `packages/harness-core/src/features/skill/feature.ts`（watch(extraDirs) 触发 reloadSources([extra])）
- [x] 目录解析语义（相对工作目录解析、~ 展开、source 标记为 extra） → `packages/harness-core/src/features/skill/catalog/roots.ts`（configuredRoots）

## 结论

全部对齐。
