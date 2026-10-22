# IAgentBlobService（agentBlobService）

- v2: `packages/agent-core-v2/src/agent/blob/agentBlobService.ts`（约 18 行，读 interface 与 agentBlobServiceImpl.ts 得出）
- 新架构: `packages/agent-core/src/blob/store.ts`

## 能力对照

- [x] 大体积媒体 part（data URI 超阈值）离屏到内容寻址 blob 存储、消息里只留引用 → `packages/agent-core/src/llm/builtin/policy/store-ref/materialize.ts`（`{ kind: 'store', ref }` 媒体源，见 `packages/agent-core/src/llm/message.ts`），存储本体 `packages/agent-core/src/blob/store.ts` 的 put/get/has
- [x] 引用回填（loadParts：引用 → data URI，缺失时占位）→ `packages/agent-core/src/llm/builtin/policy/store-ref/resolve.ts` 按模型能力物化或给占位文本；完整性校验失败映射为 unavailable（`packages/agent-core/src/llm/builtin/policy/store-ref/adapters/blob.ts`）
- [x] 引用格式判定（isBlobRef）→ 新栈引用即 64 位 sha256 hex，由 `packages/agent-core/src/blob/store.ts` 的 `blobRef` 正则承载，不再需要 `blobref:` 协议串
- [x] 键控 blob 的 list/delete 端口 → `packages/agent-core/src/blob/backend.ts` 增加 `delete`/`list(prefix)`，`packages/agent-core/src/blob/store.ts` 的 `BlobStore` 增加 `delete(ref)`/`list()`；`openBlobStore(backend, prefix)` 按消费者划分 keyspace（对齐 v2 的 scope+prefix 隔离语义），session 容器经统一入口 `Session.blobs(prefix?)`（`blobStores(backend)` 工厂，同前缀同实例）透出，harness-core fileHistory 用 `Session.blobs('file-history')` 独占 keyspace，孤儿清扫与 retention 物理驱逐已迁移（`packages/harness-core/src/todo-features/fileHistory/feature.ts`）。注意：fileHistory 备份物理位置由共享 `data/` 迁入 `file-history/` keyspace，此前写入的 dev 会话备份不再可读（新栈未发布，不迁移）

## 结论

已对齐——媒体离屏/回填能力由 store-ref 体系承载，list/delete 端口与 fileHistory 的孤儿清扫、retention 物理驱逐均已按 per-consumer keyspace 设计迁移。
