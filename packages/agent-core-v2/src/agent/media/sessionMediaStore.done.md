# ISessionMediaStore（sessionMediaStore）

- v2: `packages/agent-core-v2/src/agent/media/sessionMediaStore.ts`（约 40 行，读 interface 与 sessionMediaStoreService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/files/registry.ts`

## 能力对照

- [x] 按 fileId 读取媒体字节与文件名（read）→ `packages/harness-core/src/features/files/registry.ts`（KimiFileRegistry.get，kimi-file:// 引用解析）
- [x] 打开为可流式、可 range 读取的媒体文件（open）→ `packages/harness-core/src/features/files/registry.ts`（KimiFileRegistry.open 返回 StoredFile，stream 支持 range）
- [x] 物化到本地可读路径/StoredFile（materialize，含元数据 name/mediaType/size）→ `packages/harness-core/src/features/files/registry.ts`（KimiFileRegistry.materialize；元数据经 kimiFileProjection durable 投影持久）
- [x] 展示路径解析（resolveDisplayPath/pathFor）→ `packages/harness-core/src/features/files/registry.ts` + `packages/harness-core/src/features/files/ref.ts`（kimi-file:// 体系统一承载文件身份与展示，媒体引用第 147 轮已统一到该体系）

## 结论

全部对齐（会话媒体的读、开、物化与展示路径能力已由 files feature 的 KimiFileRegistry 统一承载）。
