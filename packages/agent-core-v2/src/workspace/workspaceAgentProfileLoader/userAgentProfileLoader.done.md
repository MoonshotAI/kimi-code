# IUserAgentProfileLoader（userAgentProfileLoader）

- v2: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/userAgentProfileLoader.ts`（约 12 行，读 interface 与 userAgentProfileLoaderService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/profiles/discovery/finders.ts`（createUserFinder）

## 能力对照

- [x] 用户级 agent 目录发现加载（source=user，priority 10）→ createUserFinder + userAgentRoots
- [x] 品牌 home 的 system.md 作为默认 profile（存在即替换并追加进目录）→ createUserFinder 内的 loadSystemMdProfile 与 currentDefault 更替逻辑
- [x] getDefaultProfile() → `UserProfileFinder.defaultProfile()`，目录侧亦可用 `ProfileCatalogRef.getDefault()`（features/profiles/feature.ts）
- [x] 其余 loader 的基提示取自该默认值 → feature.ts 的 userBasePrompt 传递给 workspace/extra/explicit finder
- [x] ready/reload → `ProfileCatalogRef.ready/reload()`

## 结论

全部对齐——用户级发现、system.md 默认 profile 与基提示链均在 createUserFinder 中有等价承载。
