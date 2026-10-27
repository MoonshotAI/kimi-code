# IExtraAgentProfileLoader（extraAgentProfileLoader）

- v2: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/extraAgentProfileLoader.ts`（约 10 行，读 interface 与 extraAgentProfileLoaderService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/profiles/discovery/finders.ts`（createExtraFinder）

## 能力对照

- [x] 从配置的额外 agent 目录发现加载（source=extra，priority 20）→ createExtraFinder + configuredAgentRoots，经 `CreateProfilesProps.extraAgentDirs` 注入（features/profiles/feature.ts）
- [x] 基础系统提示取自用户默认 profile → feature.ts 的 userBasePrompt
- [x] ready/reload → `ProfileCatalogRef.ready/reload()`（features/profiles/feature.ts）
- [ ] 配置段变更自动重载（v2 订阅 IConfigService 的 extra agent dirs 段 onDidSectionChange 触发 reload）— 降级：新栈 extraAgentDirs 为创建期静态 prop，目录变更后需外部显式 `reload()` 或重建 feature，无配置订阅联动

## 结论

未对齐 1 项——加载能力本身对齐；extraAgentDirs 的配置变更自动重载未迁，改为静态注入 + 手动 reload。
