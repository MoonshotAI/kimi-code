# ISessionContext（sessionContext）

- v2: `packages/agent-core-v2/src/session/sessionContext/sessionContext.ts`（约 57 行，读 interface 与 makeSessionContext 得出）
- 新架构: `packages/agent-core/src/session/session.ts` + `packages/agent-core/src/session/space.ts`

## 能力对照

- [x] sessionId（会话标识）→ `packages/agent-core/src/session/session.ts`（`Session.id`）
- [x] workspaceId（会话-工作区关联）→ `packages/harness-core/src/features/workspaces/session.ts`（`SESSION_WORKSPACE_ID` 存于 session record metadata，`sessionWorkspaceId/withSessionWorkspace` 读写）
- [x] cwd（会话工作目录）→ 宿主注入：`packages/harness-core/src/features/os/feature.ts`（`CreateOsProps.workDir`）与 `packages/harness-core/src/features/workspaces/feature.ts`（`openSession(root, ...)` 按工作区根建会话）
- [ ] sessionDir / metaScope / scope(subKey)（会话目录与状态作用域键）— 归属宿主层/无对应：会话存储目录布局由 `packages/harness-core/src/host/session-space.ts` 承载（journal/features 目录），不暴露为会话服务；v2 state-registry 的 `scope(subKey)` 键空间概念在新栈不存在（各 feature 以自有 journal 持久化）

## 结论

未对齐 1 项——sessionDir/metaScope 归属宿主层不暴露，scope(subKey) 作用域键概念无对应（结构性消失）。
