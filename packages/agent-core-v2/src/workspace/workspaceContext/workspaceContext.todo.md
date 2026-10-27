# IWorkspaceContext（workspaceContext）

- v2: `packages/agent-core-v2/src/workspace/workspaceContext/workspaceContext.ts`（约 30 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/workspaces/`（WorkspaceEntry + WorkspacesFace）

## 能力对照

- [x] workspaceId（按 workDir 派生的稳定 id）→ `packages/harness-core/src/features/workspaces/keys.ts` 的 encodeWorkDirKey，`createOrTouch` 生成的 WorkspaceEntry.id
- [x] cwd（当前工作目录）→ 宿主注入的 workDir prop（如 createProfiles/createMcp/createWorkspaces 的 props），并由 WorkspaceEntry.root 持久化
- [x] meta（id/root/name/createdAt/lastOpenedAt）→ `packages/harness-core/src/features/workspaces/projection.ts` 的 WorkspaceEntry，经 `WorkspacesFace.get/findByRoot/list` 读取
- [ ] source（'local' 字面量）与 remoteCwd — 随 v2 远程 runtime 体系决策不迁（见 workspaceInstanceManager 对照），新栈只承载本地 workDir
- [ ] persistenceScope（会话持久化寻址前缀）— 无对应：新栈会话目录由 `packages/harness-core/src/host/session-space.ts` 的 fsSessionSpace 按 root/sessionId 直接寻址，无 scope 概念

## 结论

未对齐 2 项——workspace 标识与元数据已对齐；source/remoteCwd 随远程 runtime 体系不迁，persistenceScope 寻址模型被 session space 取代。
