# IAppendLogStore（appendLogStore）

- v2: `packages/agent-core-v2/src/persistence/interface/appendLogStore.ts`（约 62 行，读 interface 得出）
- 新架构: `packages/agent-core/src/store/writer.ts`（openWriter / Journal 端口）

## 能力对照

- [x] 追加写（append 到 scope/key 日志）→ `packages/agent-core/src/store/writer.ts` 的 Log.commit（序列化后 journal.append），Node 落盘为每日志一 jsonl 文件（`packages/agent-core/src/store/backend/node.ts`）
- [x] 读取（read 异步迭代 + 损坏行容错）→ writer.ts 的 Log.subscribe（catch-up 重放）与 replica.ts 的 createReplica；node.ts 读取时截断撕裂尾行（torn-tail truncation）
- [x] 写完成通知（onDidWrite）→ Log.subscribe 的 live commit 推送 + `packages/harness-core/src/runtime/stores.ts` 的 onCommit 桥
- [x] 冲刷与关闭（flush / flushLog / close）→ commit 即落盘可 await；nodeJournal 支持 fsync 选项；writer.close 等待全部挂起写
- [x] 多进程写安全 → `packages/agent-core/src/store/backend/node.ts` 的 writer.lock pid 文件（JournalLockedError）
- [ ] 外部修改检测（externallyModified）— 新栈无对应机制（仅依赖 writer lock 防并发），降级未迁
- [ ] 写守卫绑定（bindWriteGuard，如绑定会话锁后失锁拒写）— 无对应机制，未迁
- [ ] 整段重写（rewrite，用于 journal 修复/压缩）— 无对应；新栈以 rewind 截断 + fork 复制取代重写语义
- [ ] 日志退役排空（drainRetirements）与 acquire 引用计数 — v2 内部生命周期机制，新栈无对应

## 结论

未对齐 4 项：核心追加日志能力已由 agent-core store 承载；外部修改检测、写守卫、整段重写、退役/引用计数四类机制未迁（其中重写语义被 rewind/fork 结构取代）。
