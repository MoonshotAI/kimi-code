# IFileService（fileService）

- v2: `packages/agent-core-v2/src/app/file/fileService.ts`（约 85 行 interface，实现 fileServiceImpl.ts 约 195 行，一并读过）
- 新架构: `packages/harness-core/src/features/files/`（feature.ts 内的 FilesFace 实现 + store.ts 契约类型）

## 能力对照

- [x] save 流式上传（`f_` 前缀 id、name/media_type/expires_in_sec 元数据、索引落盘）→ `packages/harness-core/src/features/files/feature.ts` 的 `save`，HTTP 侧为 `packages/harness-core/src/feature-http/route-features/files.ts` 的 files.upload 路由
- [x] get 下载（id 校验、meta 返回、range 分段读取）→ `packages/harness-core/src/features/files/feature.ts` 的 `open`（支持 FileReadRange），路由侧 files.download 含 Range/206
- [x] 过期文件惰性清理（读写时 pruneExpired 并删盘）→ `packages/harness-core/src/features/files/feature.ts` 的 `_pruneExpired`
- [ ] delete(fileId) 删除文件 — 未迁：新栈 FilesFace 只有 save/open，feature-http 仅 POST/GET 两路由；v2 侧 kap-server `DELETE /api/v1/files/:id`（`packages/kap-server/src/routes/files.ts`）与 klient `global.files.delete` 在新栈无对应端点

## 结论

未对齐 1 项——上传/下载/过期清理已对齐，删除能力缺失。
