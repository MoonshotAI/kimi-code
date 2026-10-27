# IAtomicDocumentStore（atomicDocumentStore）

- v2: `packages/agent-core-v2/src/persistence/interface/atomicDocumentStore.ts`（约 29 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/config/persist.ts`（createTomlConfigPersist，原子 rename 写）

## 能力对照

- [x] 原子文档读写（get/set/delete，实际消费面为配置文件）→ `packages/harness-core/src/features/config/store.ts` 的 ConfigStore.get/set + `packages/harness-core/src/features/config/persist.ts` 的 tmp+rename 原子落盘
- [x] JSON 用户配置文档（mcp 服务器配置）→ `packages/harness-core/src/features/mcp/config/store.ts` 的 McpUserConfigStore（串行化 mutate + 原子写）
- [x] 文档变更监听（v2 由实现侧 watch 承担）→ persist.ts 的 watch（fsWatch 目录监听）
- [ ] 通用 scope/key 枚举（list(scope, prefix)）— 无对应；新栈配置节为已知键集合，无通用前缀枚举服务，机制未迁
- [ ] 文档级 acquire 句柄（跨读者/写者引用计数）— 无对应；写串行化改由 ConfigStore/mutationTail 内部承担

## 结论

未对齐 2 项：原子文档持久化的实际消费面（config TOML、mcp JSON、workspaces JSONL 见 workspaces/feature.ts）均已对齐；通用枚举 list 与 acquire 句柄两个机制在新栈两个包内无承载。
