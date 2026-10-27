# IFileSystemStorageService（fileSystemStorageService）

- v2: `packages/agent-core-v2/src/persistence/interface/storage.ts`（约 156 行，读 interface 与错误域得出）
- 新架构: `packages/agent-core/src/store/backend/node.ts`（nodeJournal）+ `packages/agent-core/src/blob/backend/node.ts`（nodeBlobBackend）

## 能力对照

- [x] 作用域字节存取（read/write，atomic 选项）→ `packages/agent-core/src/blob/backend/node.ts`（每键一文件、原子 rename）+ `packages/harness-core/src/features/os/host/types.ts` 的 OsFsPort 通用读写
- [x] 追加写（append，durable 选项）→ `packages/agent-core/src/store/backend/node.ts` 的 journal.append（jsonl 行，fsync 选项对应 durable）
- [x] 枚举与删除（list/delete）→ nodeJournal.names(prefix) 与 `packages/harness-core/src/host/session-space.ts` 的 rm/cp（FsSessionSpace 目录管理）+ OsFsPort.readdir/remove
- [x] 范围读（readStream 带 range）→ OsFsPort.readBytes(n, offset)
- [x] 元信息（size/mtime）→ OsFsPort.stat/lstat（HostFileStat.size/mtimeMs）
- [x] 存储错误域（StorageErrors 七码 + errno 映射）→ `packages/harness-core/src/features/os/host/types.ts` 的 HostFsError/toHostFsError（os.fs.* 八码 + retryable）
- [x] 冲刷/关闭（flush/close）→ nodeJournal 的 close 与 fsync 选项；writer.close 等待挂起写
- [ ] 物理路径暴露（pathFor）— 新栈引擎不暴露存储物理路径（路径构造藏于 nodeJournal/FsSessionSpace 内部），机制未迁
- [ ] 同步元信息（sizeSync）— OsFsPort 全异步，无同步 stat 入口，未迁

## 结论

未对齐 2 项：作用域字节存储的全部读写能力已由 journal/blob/fs 三端口结构承载；pathFor 与 sizeSync 两个小机制未迁。
