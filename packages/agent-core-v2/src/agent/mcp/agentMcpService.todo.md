# IAgentMcpService（agentMcpService）

- v2: `packages/agent-core-v2/src/agent/mcp/mcp.ts`（约 30 行，读 interface 与 mcpService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/mcp/feature.ts`

## 能力对照

- [x] 等待 MCP 初始加载（step/工具执行前阻塞）→ `packages/harness-core/src/features/mcp/feature.ts`（agent 层 useReady(initialLoad)）
- [x] 按服务器状态镜像工具：connected 注册工具、needs-auth 注册认证工具、disabled 注销 → `packages/harness-core/src/features/mcp/feature.ts`（mirrorConnected/mirrorNeedsAuth）+ `packages/harness-core/src/features/mcp/tools/authenticate.ts`
- [x] deferred 服务器与迟到连接的工具经 deferred 通道（system 消息附 schema）下发 → `packages/harness-core/src/features/mcp/deferred.ts`
- [x] 工具名冲突规划（qualifyMcpToolName/碰撞规避）→ `packages/harness-core/src/features/mcp/tools/mcp-tool.ts`（planMcpToolRegistrations）
- [x] 调用期遇 stale client 时 join 已愈合连接或重连 → `packages/harness-core/src/features/mcp/tools/mcp-tool.ts`（reconnectForServer）
- [x] list/reconnect/onStatusChange/getRemoteServerUrl/resolved → `packages/harness-core/src/features/mcp/core/connection-manager.ts` + `packages/harness-core/src/features/mcp/feature.ts`（McpRef facade 暴露 list/reconnect/reload/connect/disconnect，状态经 mcp.server.state 事件外发）
- [x] OAuth 服务（授权 URL、token 刷新、失效重连）→ `packages/harness-core/src/features/mcp/oauth/service.ts` + `packages/harness-core/src/features/mcp/feature.ts`（mcp.oauth.authorization_url 事件）
- [x] MCP 工具结果输出整形 → `packages/harness-core/src/features/mcp/core/output.ts`
- [ ] mcp.tools_discovered durable 发现记录（按 server+工具 hash 落盘、restore 去重，供观测面消费）— 新栈无对应 durable 记录，归属观测面未迁

## 结论

未对齐 1 项——agent 层工具注册/deferred 通道/OAuth/管理面全部迁移；仅 durable 发现记录（含碰撞清单）未在新栈落盘。
