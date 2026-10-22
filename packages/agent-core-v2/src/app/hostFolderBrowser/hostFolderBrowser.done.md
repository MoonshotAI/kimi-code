# IHostFolderBrowser（hostFolderBrowser）

- v2: `packages/agent-core-v2/src/app/hostFolderBrowser/hostFolderBrowser.ts`（约 72 行 interface）
- 新架构: `packages/harness-core/src/features/workspaces/browse.ts`

## 能力对照

- [x] browse（仅目录条目的逐层浏览、绝对路径校验、parent 指针）→ `packages/harness-core/src/features/workspaces/browse.ts` 的 createHostFsBrowser().browse，HTTP 侧为 `packages/harness-core/src/feature-http/route-features/workspaces.ts` 的 GET fs:browse
- [x] home（home 目录 + recent_roots 最近工作区列表，上限 RECENT_ROOTS_LIMIT=8）→ browse.ts 的 home + `packages/harness-core/src/features/workspaces/wire.ts` 的 RECENT_ROOTS_LIMIT，路由侧 GET fs:home

## 结论

全部对齐——宿主文件夹浏览已迁入 workspaces feature 并经 feature-http 暴露（线索原标「宿主层不迁」，核实代码后确认已承载）。
