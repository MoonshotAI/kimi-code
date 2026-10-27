# IAtomicTomlDocumentStore（atomicTomlDocumentStore）

- v2: `packages/agent-core-v2/src/persistence/interface/atomicDocumentStore.ts`（约 29 行，读 interface 得出；与 IAtomicDocumentStore 同文件）
- 新架构: `packages/harness-core/src/features/config/persist.ts`（createTomlConfigPersist）

## 能力对照

- [x] TOML 原文读写（getText/setText，保留原始文本层）→ `packages/harness-core/src/features/config/persist.ts` 的 ConfigPersist.load/save（utf8 原文 load，tmp+rename 原子 save），上层 `packages/harness-core/src/features/config/store.ts` 保留 raw 文本与类型化值双层
- [x] 原子写入防撕裂 → persist.ts 的 `${path}.tmp-${pid}` + rename
- [x] 变更监听（v2 由实现侧承担，config 重载消费）→ persist.ts 的 watch（fsWatch 目录监听，改名即触发 onChange）
- [ ] 通用 scope/key 文档模型与 list/acquire（继承自 IAtomicDocumentStore）— 机制未迁，详见同目录 atomicDocumentStore.md

## 结论

未对齐 1 项：TOML 文本级原子读写能力已由 config persist 完整承载（config.toml 为 v2 该服务的实际消费面）；通用文档商店的 list/acquire 机制未迁。
