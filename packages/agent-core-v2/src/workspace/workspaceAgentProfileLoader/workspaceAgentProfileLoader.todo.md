# IWorkspaceAgentProfileLoader（workspaceAgentProfileLoader）

- v2: `packages/agent-core-v2/src/workspace/workspaceAgentProfileLoader/workspaceAgentProfileLoader.ts`（约 10 行，读 interface 与 workspaceAgentProfileLoaderService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/profiles/discovery/finders.ts`（createWorkspaceFinder）

## 能力对照

- [x] 项目级 agent 目录发现加载（source=workspace，priority 30，沿 git 根候选）→ createWorkspaceFinder + projectAgentRoots，经 workDir 注入（features/profiles/feature.ts）
- [x] 基础系统提示取自用户默认 profile → feature.ts 的 userBasePrompt
- [x] ready/reload → `ProfileCatalogRef.ready/reload()`（feature.ts 的 queueRebuild 串行重建）
- [ ] 项目 agents 目录的 fswatch 自动重载（v2 用 watchCandidates + 200ms 防抖，文件增删改即 reload）— 降级：新栈无文件监视，磁盘变更后需外部显式 `reload()` 才生效

## 结论

未对齐 1 项——发现与合并能力对齐；项目 agent 目录的文件监视自动重载未迁，改为手动 reload。
