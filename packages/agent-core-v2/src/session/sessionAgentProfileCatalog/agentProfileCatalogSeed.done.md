# ISessionAgentProfileCatalogSeed（sessionAgentProfileCatalogSeed）

- v2: `packages/agent-core-v2/src/session/sessionAgentProfileCatalog/agentProfileCatalogSeed.ts`（约 17 行，读声明得出）
- 新架构: `packages/harness-core/src/features/profiles/feature.ts`

## 能力对照

- [x] 为会话级 profile 目录提供工作区键（workspaceKey 种子，用于按工作区定位/缓存目录）→ 结构消失：新栈 profiles 是 app 级 feature，`createProfiles({ workDir, host, home, ... })` 由宿主经 props 注入工作区根（`packages/harness-core/src/features/profiles/feature.ts`），不再需要会话级种子与按 workspaceKey 的目录缓存
- [x] 种子所服务的目录能力本身（按工作区发现 user/workspace agent 文件）→ `packages/harness-core/src/features/profiles/discovery/finders.ts`（`createUserFinder/createWorkspaceFinder`，以 props.workDir 为根发现）
- [x] ScopeSeed 注入机制（会话创建时携带种子进 DI scope）→ 结构消失：新栈无 DI scope 种子概念，feature 挂载即读 props
- [x] 消费方（sessionAgentProfileCatalog 目录）→ `packages/harness-core/src/features/profiles/feature.ts`（`ProfileCatalogRef`；对照详见同目录 sessionAgentProfileCatalog.md）

## 结论

全部对齐；workspaceKey 种子概念被 app 级 profiles feature 的宿主 props 注入替代。
