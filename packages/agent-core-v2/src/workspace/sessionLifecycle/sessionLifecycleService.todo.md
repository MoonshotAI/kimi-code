# ISessionLifecycleService（sessionLifecycleService）

- v2: `packages/agent-core-v2/src/workspace/sessionLifecycle/sessionLifecycle.ts`（约 95 行，读 interface 与 sessionLifecycleService.ts 实现得出）
- 新架构: `packages/harness-core/src/app/app.ts`（createApp）+ `packages/agent-core/src/session/` + `packages/harness-core/src/host/session-space.ts`（fsSessionSpace）

## 能力对照

- [x] create（新建会话并物化运行态）→ `packages/harness-core/src/app/app.ts` 的 `App.create`，落盘由 `packages/harness-core/src/host/session-space.ts` 的 fsSessionSpace 承担
- [x] resume/get/list（恢复与活动会话表）→ `App.open`（source='resume'，live 会话直接复用）与 `App.sessions`
- [x] close/delete → `App.close(sessionId)` 与 `App.delete`（先 closeOne 再 space.delete 整目录删除）
- [x] fork → `App.open(forkId, { from })` + `SessionSpace.copy`，HTTP 侧为 `packages/harness-core/src/feature-http/route-builtin/sessions.ts` 的 fork action
- [x] archive → 同文件 sessions.ts 的 archive action（写 metadata.archived/archived_at），索引侧 `packages/harness-core/src/features/sessionIndex/` 有 archived 列与过滤
- [x] 创建/删除/元数据事件 → app.ts 的 `session.created`/`session.deleted`/`session.meta_updated` 运行时事件
- [x] 外部参与会话创建（v2 的 onWillCreateSession contributeSeed）→ 结构性替代：`packages/harness-core/src/app/features.ts` 的 feature 接缝（session 级 feature + `useOn('session.created')`）
- [ ] onWillCloseSession 的 IWaitUntil 阻塞式异步清理钩子 — 未迁：新栈内核无 waitUntil 参与点，delete/close 不可被外部挂起
- [ ] fork 的 turnIndex 截断（sliceMainRecordsAtTurn 按轮次切片主/子 agent 记录）— 未见等价，space.copy 为整容器拷贝
- [ ] createChild（写 PARENT_SESSION_ID/CHILD_SESSION_KIND 的父子会话）— 未见等价（新栈无父子会话概念）
- [ ] delete 的 session_index 墓碑与 fileHistory retention 联动（coldSessionArchive 等）— 未迁：fsSessionSpace.delete 直接 rm -rf，sessionIndex 直接删行，无墓碑、无 retention
- [ ] fork 的 busy 守卫（SESSION_FORK_ACTIVE_TURN + quiescence hold）与 restore（unarchive）专用动作 — 未迁：新栈 fork/delete 不加 turn 守卫（语义决策），restore 只能经通用 update 改写 metadata

## 结论

未对齐 6 项——核心 CRUD/fork/archive/事件已对齐；缺口集中在 waitUntil 清理钩子、turn 截断 fork、父子会话、删除墓碑与 retention、busy 守卫及 restore 动作。
