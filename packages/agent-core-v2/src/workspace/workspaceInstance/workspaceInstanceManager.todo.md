# IWorkspaceInstanceManager（workspaceInstanceManager）

- v2: `packages/agent-core-v2/src/workspace/workspaceInstance/workspaceInstanceManager.ts`（约 40 行，读 interface 得出）
- 新架构: 无对应（决策不迁）；多 workspace 目录登记能力由 `packages/harness-core/src/features/workspaces/` 部分承载

## 能力对照

- [x] 按 root 登记/查找 workspace（findByRoot 语义）→ `packages/harness-core/src/features/workspaces/feature.ts` 的 `WorkspacesFace.findByRoot/list/createOrTouch`
- [ ] WorkspaceInstance（每个 workspace 一个独立 LifecycleScope.Workspace 与服务容器，getOrCreate/close/onDidChange/snapshot）— 决策不迁：新架构无 workspace 级 DI scope，feature 只分 app/session/agent 三层，workspace 退化为目录登记 + workDir 注入
- [ ] addProvider(RuntimeProviderFactory) 远程 runtime 提供者注册 — 归属 kap-server 的远程 runtime 体系，决策不迁（新架构以宿主注入 OsHost 端口承载本地能力）
- [ ] findContaining（按 cwd 归属 workspace）→ 近似能力见 `WorkspacesFace.locate`（按 root+additionalDirs 归属），但服务于 fs/agentsMd 场景，不承载实例语义

## 结论

未对齐 3 项——workspace 目录登记已迁往 workspaces feature；实例容器、远程 runtime 提供者体系与实例生命周期整体决策不迁（归属 kap-server/宿主端口替代）。
