# IWorkspaceRootSkillSource（workspaceRootSkillSource）

- v2: `packages/agent-core-v2/src/features/skill/workspace/rootFileSkillSource.ts`（约 114 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/sources/files.ts`

## 能力对照

- [x] 工作区技能源（id=workspace、优先级 workspace）：扫描项目根技能候选目录 → `packages/harness-core/src/features/skill/sources/files.ts`（createWorkspaceSkillSource）与 `packages/harness-core/src/features/skill/catalog/roots.ts`（projectRoots）
- [x] mergeAllAvailableSkills 语义 → `packages/harness-core/src/features/skill/catalog/roots.ts`（projectRoots 的 mergeAllAvailableSkills 选项）
- [x] 存在显式 --skill-dir 时本源置空 → `packages/harness-core/src/features/skill/sources/files.ts`（deps.hasExplicitDirs() 时返回空贡献）
- [x] mergeAllAvailableSkills 配置变更后重载 → `packages/harness-core/src/features/skill/feature.ts`（watch(mergeAll) 触发 reloadSources([user, workspace])）
- [ ] 项目技能目录的文件系统监视（按已扫描目录增量调整 watcher、SKILL.md 变更 200ms 防抖自动重载） — 决策不迁：新栈以显式 SkillCatalogRef.reload()（`packages/harness-core/src/features/skill/feature.ts`）代替目录监视

## 结论

未对齐 1 项——fs 目录监视按决策不迁（reload 代替），其余能力对齐。
