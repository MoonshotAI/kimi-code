# IWorkspaceSkillCatalog（workspaceSkillCatalog）

- v2: `packages/agent-core-v2/src/features/skill/workspace/workspaceSkillCatalog.ts`（约 20 行，读 interface 与实现得出；实现为同目录 workspaceSkillCatalogService.ts）
- 新架构: `packages/harness-core/src/features/skill/feature.ts`

## 能力对照

- [x] 六源聚合并按优先级合并（builtin/plugin/extra/user/workspace/explicit，优先级值同序保留） → `packages/harness-core/src/features/skill/feature.ts`（app slot：SkillSources 集合 + remerge）与 `packages/harness-core/src/features/skill/sources/source.ts`（SKILL_SOURCE_PRIORITY）
- [x] ready/load/reload/reloadSources → `packages/harness-core/src/features/skill/feature.ts`（SkillCatalogRef.ready/reload；reloadSources 内部化，供配置 watch 与源失效使用）
- [x] 源 onDidChange 订阅与逐源串行加载（v2 loadTails 链） → 同文件（syncSubscriptions/loadSource 串行链）
- [x] 变更通知（携带 sourceId 的 onDidChange） → 同文件（skill.changed 事件）
- [x] sessionData() 会话数据桥 → 结构取代：app 级 catalog 直接经 SkillCatalogRef 注入 agent slot（同文件 agent()），不再需要桥接对象

## 结论

全部对齐；workspace 级聚合服务由 skill feature 的 app slot 结构取代。
