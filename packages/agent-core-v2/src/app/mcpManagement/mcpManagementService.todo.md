# IMcpManagementService（mcpManagementService）

- v2: `packages/agent-core-v2/src/app/mcpManagement/mcpManagement.ts`（约 130 行 interface）
- 新架构: `packages/harness-core/src/features/mcp/feature.ts` + `packages/harness-core/src/feature-http/route-features/mcp.ts`

## 能力对照

- [x] listServers/getServer（global/plugin/caller 三源合并视图，origin/mutable 标记）→ feature.ts 的 `_buildRegistry`/listServers/getServer + mcp.ts 路由
- [x] addServer/updateServer/removeServer（仅写用户层、只读层守卫、caller 源断开）→ feature.ts 同名方法 + mcp.ts REST 路由
- [x] testServer（独立探针连接测试，列工具清单）→ feature.ts 的 `testServer`（createProbe + standaloneTestResult）
- [x] inspectServers/listAuthStatuses（连接与 OAuth 状态巡检，verify 开关）→ feature.ts 同名方法
- [x] begin/complete/cancel/resetServerAuth 授权四流程（flowId 句柄、空闲超时）→ feature.ts 同名方法 + mcp.ts auth 路由
- [ ] resolveServerByName（按名字解析 locator；klient `mcpManagementService.resolveServerByName` 与 node-sdk auth 流程消费）— 未迁：新栈 auth 路由要求客户端直接提交 locator，无名字解析端点
- [ ] 列表项 plugin 来源显示名（v2 McpManagedServer.plugin={id,name}）— 降级：新栈 McpServerSource 只有 id，toManagedServer 恒置 plugin=undefined，来源信息仅剩 origin 字符串

## 结论

未对齐 2 项——CRUD/test/inspect/auth 主流程已对齐；名字解析 RPC 与 plugin 来源显示名未迁。
