# IQueryStore（queryStore）

- v2: `packages/agent-core-v2/src/persistence/interface/queryStore.ts`（约 120 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/sessionIndex/query.ts`（session 域 sqlite 查询层）

## 能力对照

- [x] 过滤/排序/游标分页查询（query().where/orderBy/limit/cursor）→ `packages/harness-core/src/features/sessionIndex/query.ts` 的 SessionIndexQuery（workspaceIds/archived/updatedAfter/hasPrompt 过滤、updated_at/created_at 排序、pageToken 分页，基于 better-sqlite3）
- [x] 分组分页（v2 pageByColumn 的消费面：按 workspace 分组列会话）→ query.ts 的 SessionIndexGroupQuery / SessionGroupPage
- [x] 索引化存储（v2 ensureIndex 的消费面）→ `packages/harness-core/src/features/sessionIndex/schema.ts` 的 sqlite 表结构（SessionSummaryRow）
- [ ] 通用集合写入（put/batch/delete/get/getMany/listKeys/dropCollection）— 写路径未做：新栈索引由 `packages/harness-core/src/features/sessionIndex/scan.ts` 的 scanSessionDir 扫描重建，无通用文档写入面，降级
- [ ] 自定义索引定义（value/compound/text 三类 IndexDef）— 无对应，索引结构固化为 session 摘要表
- [ ] 增量同步检查点（getCheckpoint/setCheckpoint/storeEpoch + QueryStoreRebuiltError）— 无对应机制，未迁

## 结论

未对齐 3 项：查询读面由 sessionIndex 的 sqlite 层承载（仅限 session 域）；通用写路径、自定义索引、检查点机制均未迁（spike 出身，写路径降级为扫描重建）。
