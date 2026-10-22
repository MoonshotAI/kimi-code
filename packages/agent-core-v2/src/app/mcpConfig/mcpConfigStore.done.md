# IMcpConfigStore（mcpConfigStore）

- v2: `packages/agent-core-v2/src/app/mcpConfig/configStore.ts`（约 225 行，interface 与实现同文件，均读过）
- 新架构: `packages/harness-core/src/features/mcp/config/store.ts`（McpUserConfigStore）

## 能力对照

- [x] 全局 mcp.json 的增/改/删（串行化变更、原子写、保留 mcpServers 外未知字段、重名/缺失报错）→ `packages/harness-core/src/features/mcp/config/store.ts` 的 McpUserConfigStore.add/update/remove（mutate 串行链）
- [x] list/get 读取 → 由 `packages/harness-core/src/features/mcp/config/loader.ts` 三层合并读取与 `packages/harness-core/src/features/mcp/feature.ts` 的 listServers/getServer 承载
- [x] path 暴露 → McpUserConfigStore.readonly path
- [x] 写后重载通知（v2 的 onDidWrite waitUntil 事件）→ 结构性替代：feature.ts 每次变更后显式调用 reloadServers()

## 结论

全部对齐——mcp.json CRUD 由 McpUserConfigStore 承载，onDidWrite 事件机制由显式 reload 结构性替代。
