# IBlobStore（blobStore）

- v2: `packages/agent-core-v2/src/persistence/interface/blobStore.ts`（约 21 行，读 interface 得出）
- 新架构: `packages/agent-core/src/blob/store.ts`（openBlobStore）

## 能力对照

- [x] 二进制存取（put/get）→ `packages/agent-core/src/blob/store.ts` 的 openBlobStore（put 编码 length-prefix 头 + bytes，get 未知 ref 返回 undefined）
- [x] 内容寻址与完整性校验 → store.ts 的 ref = sha256，校验失败抛 BlobIntegrityError
- [x] 存在性判断（has）→ `packages/agent-core/src/blob/backend.ts` 的 BlobBackend.has
- [x] Node 落盘 → `packages/agent-core/src/blob/backend/node.ts`（每键一文件，原子 rename）；另有 memory / durable-object 后端
- [x] 命名空间缓存（v2 无直接对应，同域能力）→ `packages/agent-core/src/blob/cache.ts` 的 openBlobCache
- [ ] 流式写入（putStream）— 新栈 put 为整值写入，无流式入口，降级未迁
- [ ] 范围流式读（getStream 带 BlobReadRange）— backend.read 为整值读，无范围读取，未迁
- [x] 删除与枚举（delete / list(scope, prefix)）— `packages/agent-core/src/blob/backend.ts` 的 `delete`/`list(prefix)` 与 `store.ts` 的 `BlobStore.delete/list`；scope+prefix 隔离语义由 `openBlobStore(backend, prefix)` 的 per-consumer keyspace 承载（如 fileHistory 独占 `file-history/`）

## 结论

未对齐 2 项：内容寻址 blob 存取、完整性校验与 delete/list 已对齐；流式写入与范围流式读在新栈端口上不存在（媒体类大对象当前经 llm store-ref 适配消费整值）。
