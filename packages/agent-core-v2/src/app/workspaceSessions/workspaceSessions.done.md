# IWorkspaceSessions（workspaceSessions）

- v2: `packages/agent-core-v2/src/app/workspaceSessions/workspaceSessions.ts`（约 17 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/workspaces/feature.ts`（sessionCount/openSession）+ `packages/harness-core/src/features/sessionIndex/`（listByWorkspace）

## 能力对照

- [x] count(workspaceId)（按别名候选集统计归属会话）→ `WorkspacesFace.sessionCount`（aliases 反查 + 会话 metadata.workspaceId 匹配）
- [x] listRecent(workspaceId)（该 workspace 最近会话摘要，v2 固定 RECENT_SESSIONS_LIMIT=20）→ `packages/harness-core/src/features/sessionIndex/feature.ts` 的 `SessionIndexFace.list/listByWorkspace`（SQLite 索引，含 archived 过滤与参数化分页；query.ts 支持 workspace 维度）
- [x] 会话与 workspace 的归属元数据契约（metadata 中的 workspaceId 键）→ `packages/harness-core/src/features/workspaces/session.ts` 的 SESSION_WORKSPACE_ID/withSessionWorkspace
- [x] 会话与 workspace 的归属建立（v2 由会话创建路径写索引）→ `WorkspacesFace.openSession`（withSessionWorkspace 写 metadata）+ feature.ts 对 `session.created` 的检测：无归属会话按 defaultRoot 自动 createOrTouch 并回填归属

## 结论

全部对齐——按 workspace 统计与列举会话的能力由 workspaces feature 的归属写入/统计与 sessionIndex 的维度查询共同承载。
