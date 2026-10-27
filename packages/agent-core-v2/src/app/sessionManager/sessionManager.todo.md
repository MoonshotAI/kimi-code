# ISessionManager（sessionManager）

- v2: `packages/agent-core-v2/src/app/sessionManager/sessionManager.ts`（约 55 行 interface）
- 新架构: `packages/harness-core/src/app/app.ts`（createApp/App.open）+ `packages/agent-core/src/session/` + `packages/harness-core/src/host/session-space.ts`（fsSessionSpace）

## 能力对照

- [x] create/resume（新建/恢复并物化运行态）→ app.ts 的 App.open（CreateSessionInput，source='startup'/'resume'）
- [x] get/list（活动会话句柄表）→ app.ts 的 App.sessions
- [x] status（会话摘要查询）→ `packages/harness-core/src/features/sessionIndex/` 的 SessionIndexFace.get + `packages/harness-core/src/feature-http/route-builtin/sessions.ts`
- [x] whenResumeSettled（并发恢复去重）→ app.ts 的 creating in-flight map（live ?? creating）
- [x] close/delete → App.close(sessionId)/App.delete（落盘由 host/session-space.ts 承担）
- [x] archive → sessions.ts 的 archive action（写 metadata.archived/archived_at）
- [x] fork → App.open(forkId, { from }) + SessionSpace.copy + sessions.ts 的 fork action
- [x] 生命周期事件（onDidCreate/onDidClose/onDidArchive/onDidFork 等）→ app.ts 的 session.created/session.deleted/session.meta_updated 运行时事件
- [ ] onWillCreate/onWillClose/onWillDelete 的 IWaitUntil 阻塞式清理钩子 — 未迁：新栈内核无 waitUntil 参与点，close/delete 不可被外部挂起
- [ ] createChild（PARENT_SESSION_ID/CHILD_SESSION_KIND 父子会话）— 未迁：新栈无父子会话概念
- [ ] fork 的 turnIndex 截断与 busy 守卫 — 未迁：space.copy 为整容器拷贝，fork 不加 turn 守卫（语义决策）
- [ ] restore（unarchive）专用动作与 withLifecycleSerialization 生命周期串行化守卫 — 未迁：恢复只能经通用 metadata update，无串行化守卫
- [ ] delete 的 session_index 墓碑与 fileHistory retention 联动 — 未迁：fsSessionSpace.delete 直接整目录删除，sessionIndex 直接删行，无墓碑、无 retention

## 结论

未对齐 5 项——核心 CRUD/fork/archive/事件已对齐；waitUntil 钩子、父子会话、turn 截断 fork、restore 守卫、删除墓碑与 retention 未迁。
