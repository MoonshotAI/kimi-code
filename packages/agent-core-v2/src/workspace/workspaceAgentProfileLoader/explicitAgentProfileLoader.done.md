# IExplicitAgentProfileLoader（explicitAgentProfileLoader）

- v2: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/explicitAgentProfileLoader.ts`（约 10 行，读 interface 与 explicitAgentProfileLoaderService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/profiles/discovery/finders.ts`（createExplicitFinder）

## 能力对照

- [x] 从启动参数指定的 agent 文件逐个解析加载（source=explicit，priority 40 最高）→ `packages/harness-core/src/features/profiles/discovery/finders.ts` 的 createExplicitFinder，经 `CreateProfilesProps.explicitAgentFiles` 注入（features/profiles/feature.ts）
- [x] 文件不可读/不可解析即致命（fatal）→ createExplicitFinder 的 `fatal: true`，feature.ts 的 loadOne 对 fatal finder 直接抛错
- [x] 基础系统提示取自用户默认 profile → feature.ts 的 userBasePrompt（userFinder.defaultProfile() 回退 builtin 默认）
- [x] ready/reload → `ProfileCatalogRef.ready/reload()`（features/profiles/feature.ts）

## 结论

全部对齐——显式 agent 文件加载、fatal 语义与基提示链均在 profiles finder 体系中有等价承载。
