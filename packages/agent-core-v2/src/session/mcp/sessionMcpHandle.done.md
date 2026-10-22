# ISessionMcpHandle（sessionMcpHandle）

- v2: `packages/agent-core-v2/src/session/mcp/sessionMcpHandle.ts`（约 18 行，读 interface 得出）
- 新架构: `packages/harness-core/src/features/mcp/feature.ts`

## 能力对照

- [x] ready（初始连接就绪等待）→ `packages/harness-core/src/features/mcp/feature.ts`（`initialLoad`，经 management 的 `ready: () => initialLoad` 暴露）
- [x] connectionManager 连接视图（列表/状态/重连）→ `packages/harness-core/src/features/mcp/types.ts`（`McpFacade`：`list/reconnect/reload/connect/disconnect` 及管理能力）+ `packages/harness-core/src/features/mcp/core/connection-manager.ts`（`McpConnectionManager`）
- [x] isBaselineServer（区分基线配置与临时服务器）→ `packages/harness-core/src/features/mcp/feature.ts`（`_buildRegistry` 为每个服务器标注 `source`：global/plugin/caller，caller 即 ephemeral；经 `inspectServers` 暴露）
- [x] 服务器状态变更通知（v2 经 connectionManager 视图订阅）→ `packages/harness-core/src/features/mcp/feature.ts`（`manager.onStatusChange` 发 `mcp.server.state` feature 事件）

## 结论

全部对齐；会话级句柄改为 app 级 Mcp facade 加来源标签，结构不同但能力等价。
