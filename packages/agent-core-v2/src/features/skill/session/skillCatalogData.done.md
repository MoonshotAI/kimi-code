# ISessionSkillCatalogData（sessionSkillCatalogData）

- v2: `packages/agent-core-v2/src/features/skill/session/skillCatalogData.ts`（约 20 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/skill/feature.ts`

## 能力对照

- [x] 纯数据视图（ready/catalog/onDidChange；v2 由 IWorkspaceSkillCatalog.sessionData() 桥接产出） → `packages/harness-core/src/features/skill/feature.ts`（SkillCatalogRef face：ready + list/get 等读取方法 + skill.changed 事件）
- [x] 作用域种子注入（sessionSkillCatalogDataSeed 把数据塞进 session 作用域） → 结构取代：新栈 catalog 为 app 级单元，agent slot 直接 useInject(SkillCatalogRef)（`packages/harness-core/src/features/skill/feature.ts` agent()），无需种子机制

## 结论

全部对齐；纯数据接口按结构取代，由 SkillCatalogRef 门面承载。
