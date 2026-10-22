# IWorkspaceMcpService（workspaceMcpService）

- v2: `packages/agent-core-v2/src/workspace/workspaceMcp/workspaceMcp.ts`（约 31 行，读 interface 与 workspaceMcpService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/mcp/`（createMcp + McpConnectionManager）

## 能力对照

- [x] connectionManager()（工作区级共享 MCP 连接管理）→ `packages/harness-core/src/features/mcp/core/connection-manager.ts` 的 McpConnectionManager（createMcp 在 app 级持有唯一实例）
- [x] sessionHandle()（会话可见的共享连接视图与基线 server 判定）→ 结构性替代：`packages/harness-core/src/features/mcp/feature.ts` 的 agent() 层把 manager 的工具镜像进各 agent runtime（含 deferred 通道）
- [x] sessionOverlay(servers, {stdioCwd})（会话级临时 server 叠加、独立 stdio cwd、随会话销毁）→ feature.ts 的 `shared.ephemeral` + `McpRef.connect/disconnect`，按 `sessionCwd`/`visibleToSession` 做会话可见性隔离
- [x] OAuth 事件联动重连（tokens-saved/refresh-failed 等）→ feature.ts 的 `handleMcpOAuthEvent` 订阅
- [x] ready（初始连接完成）→ feature.ts 的 `initialLoad`（agent 层 useReady）

## 结论

全部对齐——共享连接、会话视图、临时叠加与 OAuth 联动均在 mcp feature 中有等价承载（结构由「每会话 overlay 管理器」改为「共享管理器 + ephemeral 可见性」）。
