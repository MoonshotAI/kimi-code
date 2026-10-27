# IUserFileSkillSource（userFileSkillSource）

- v2: `packages/agent-core-v2/src/features/skill/catalog/userFileSkillSource.ts`（约 106 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/sources/files.ts`

## 能力对照

- [x] 用户级技能源（id=user、优先级 user）：扫描 ~/skills 与 ~/.agents/skills → `packages/harness-core/src/features/skill/sources/files.ts`（createUserSkillSource）与 `packages/harness-core/src/features/skill/catalog/roots.ts`（userRoots）
- [x] mergeAllAvailableSkills 语义（合并全部可用目录 vs 首个命中） → `packages/harness-core/src/features/skill/catalog/roots.ts`（userRoots 的 mergeAllAvailableSkills 选项）与 `packages/harness-core/src/features/skill/feature.ts`（mergeAllAvailableSkillsSection 注册）
- [x] 存在显式 --skill-dir 时本源置空 → `packages/harness-core/src/features/skill/sources/files.ts`（deps.hasExplicitDirs() 时返回空贡献）
- [x] mergeAllAvailableSkills 配置变更后重载 → `packages/harness-core/src/features/skill/feature.ts`（watch(mergeAll) 触发 reloadSources([user, workspace])）
- [ ] 用户技能目录的文件系统监视（watchCandidates + 200ms 防抖，磁盘改动自动失效重载） — 决策不迁：新栈以显式 SkillCatalogRef.reload()（`packages/harness-core/src/features/skill/feature.ts`）代替目录监视

## 结论

未对齐 1 项——fs 目录监视按决策不迁（reload 代替），其余能力对齐。
