# IAgentFileHistoryService（agentFileHistoryService）

- v2: `packages/agent-core-v2/src/features/fileHistory/fileHistory.ts`（接口约 60 行；实现 `fileHistoryService.ts` 约 460 行 + `fileHistoryRetention.ts` 约 125 行，读 interface 与实现得出）
- 新架构: `packages/harness-core/src/features/fileHistory/feature.ts`（facade 与接线）+ `projection.ts`（durable 投影）

## 能力对照

- [x] `history()/settled()/captureForActiveTurn()/changes(turnId)/turnRecorded(turnId)/contentAt(turnId,path,phase)` 六方法全量迁移（含串行队列、缺失/不可读/oversize 4MiB 分支、二进制与丢 blob 降级）→ `packages/harness-core/src/features/fileHistory/feature.ts`
- [x] turn 起止检查点（start/end 两相位）与 Edit/Write 捕获接线；非主 agent 的写入归并到主 agent 捕获 → `packages/harness-core/src/features/fileHistory/feature.ts`（`useToolStarting` + `useLoopEvent('turn.started'|'turn.ended')`）
- [x] 检查点与追踪状态的事件溯源持久化 → `packages/harness-core/src/features/fileHistory/projection.ts`
- [x] 内容寻址 blob 备份与 diff 统计（additions/deletions，LCS 预算）→ `packages/harness-core/src/features/fileHistory/diff.ts` 与 feature 内 `_backup`/`_readChanges`
- [ ] 孤儿 blob 物理清扫 — v2 `sweepOrphanBlobs` 列取 `file-history/` 前缀下全部 blob 并删除未被引用的；新栈 `BlobStore` 只有 `put/get/has`（`packages/agent-core/src/blob/store.ts`），内容寻址无 list/delete 端口，无法清扫
- [ ] 检查点驱逐时的 blob 物理删除 — v2 `evictBlobs` 在被取代检查点不再引用时删除其 blob；同上，无 delete 端口未迁
- [ ] 30 会话 LRU retention — v2 `fileHistoryRetention.ts` 按 workspace 维护 30 个会话窗口，物理移除逐出会话的 file-history blob 目录（含 touch/drop/fork touch）；新栈无对应，旧会话备份 blob 永久累积

## 结论

未对齐 3 项——blob 物理清扫、驱逐删除与 30 会话 LRU 全部受制于新栈内容寻址 blob 无 list/delete 端口；六个查询/捕获方法与 turn 检查点管线已完整迁移。
