# McpOAuthService（mcpOAuthService）

- v2: `packages/agent-core-v2/src/app/mcpConfig/oauthService.ts`（约 43 行；能力主体在 `packages/agent-core-v2/src/mcpCore/oauth/service.ts` 约 740 行，略读）
- 新架构: `packages/harness-core/src/features/mcp/oauth/service.ts`

## 能力对照

- [x] OAuth 授权流程（beginAuthorization：发现元数据、动态注册、本地回调服务器、共享流去重）→ `packages/harness-core/src/features/mcp/oauth/service.ts` 的 McpOAuthService.beginAuthorization + callback-server.ts
- [x] token 状态查询/失效/主动刷新（tokenState/invalidate/refresh/sweepProactiveRefresh）→ 同类同名方法
- [x] tokens-saved/tokens-invalidated/refresh-failed 事件 → onEvent + `packages/harness-core/src/features/mcp/feature.ts` 的 handleMcpOAuthEvent 接线
- [x] 启动时 proactive refresh 清扫（v2 在 identity 就绪后触发）→ feature.ts 约 141 行直接调 oauthService.sweepProactiveRefresh()
- [x] 优雅关停（shutdown 排空进行中的流）→ McpOAuthService.shutdown

## 结论

全部对齐——MCP OAuth 全流程由 features/mcp/oauth 承载，v2 仅多一个按 IAgentIdentity 定制 client_name 的注入，不影响用户可见能力。
