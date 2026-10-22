# ISessionSkillCatalog（sessionSkillCatalog）

- v2: `packages/agent-core-v2/src/features/skill/session/skillCatalog.ts`（约 25 行，读 interface 与实现得出；实现为同目录 skillCatalogService.ts）
- 新架构: `packages/harness-core/src/features/skill/feature.ts`

## 能力对照

- [x] 会话内技能目录读取（catalog/ready/list() 摘要列表） → `packages/harness-core/src/features/skill/feature.ts`（SkillCatalogRef face：ready/list/get/renderSkillPrompt/listInvocableSkills 等）
- [x] 目录变更通知（onDidChange 携带 sourceId） → 同文件（SkillChangedEvent：skill.changed，携带 sourceId）
- [x] load/reload 语义 → 同文件（SkillCatalogRef.ready/reload）
- [x] 同文件声明的 ISkillCatalogSink（session 级 set/remove 覆盖贡献） → 结构取代：v2 全仓无消费者（仅声明与实现两处分），新栈由 app 级集合贡献点 `packages/harness-core/src/features/skill/sources/source.ts`（SkillSources/useSkillSource）与 CreateSkillProps.sources 承载外部贡献
- [x] 合并目录供系统提示词注入（# Skills 块） → `packages/harness-core/src/features/skill/feature.ts`（agent slot 的 useSystemPrompt + `prompt.ts` renderSkillsSection）

## 结论

全部对齐；session 级目录与 sink 由 app 级单一 catalog + 集合贡献点结构取代。
