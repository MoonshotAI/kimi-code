# ISessionIndex（sessionIndex）

- v2: `packages/agent-core-v2/src/app/sessionIndex/sessionIndex.ts`（约 72 行 interface）
- 新架构: `packages/harness-core/src/features/sessionIndex/`（better-sqlite3）

## 能力对照

- [x] get/listRecent（分页、工作区/归档/子会话过滤、游标）→ `packages/harness-core/src/features/sessionIndex/feature.ts` 的 SessionIndexFace.get/list + query.ts
- [x] count（计数查询）→ query.ts 的 listSummaries 返回 total（countWhere）
- [x] remove（删除联动）→ feature.ts 的 useOn('session.deleted') 删行 + 启动时与 app.space 对账清理
- [x] 写路径（创建/元数据/首提示/末轮 outcome 的索引维护与目录扫描回填）→ feature.ts 的 session.created/meta_updated/message.appended/turn.ended 监听 + scan.ts
- [x] HTTP 暴露 → `packages/harness-core/src/feature-http/route-v2/sessions.ts` 的 v2 sessions 路由
- [ ] prepare()/status() 生命周期状态面（uninitialized/preparing/ready/degraded 与 degradedCount）— 未迁：新栈无索引状态查询接口
- [ ] 写路径异常隔离与降级（v2 写失败降级 degraded 继续服务读）— 未迁：新栈在事件监听内同步执行 sqlite 写，异常无隔离降级
- [ ] better-sqlite3 原生模块的打包分发 — 记录在案未验证

## 结论

未对齐 3 项——查询/写入/对账主能力已对齐；状态面、写路径降级与原生模块分发未落实。
