# ISessionEphemeralMcpServers（sessionEphemeralMcpServers）

- v2: `packages/agent-core-v2/src/session/mcp/ephemeralMcpServers.ts`（约 13 行，读声明与消费方 workspaceMcpService.ts 得出）
- 新架构: `packages/harness-core/src/features/mcp/feature.ts`（ephemeral 注册表）

## 能力对照

- [x] 调用方（如 ACP 客户端）随会话注入临时 MCP 服务器 → `packages/harness-core/src/features/mcp/feature.ts`（`McpRef.connect/disconnect` 写入 `shared.ephemeral` 注册表）+ `packages/harness-core/src/feature-acp/server.ts`（会话建立时 `mcp.connect(name, config, { cwd })` 注入、结束时 disconnect）
- [x] ephemeral 服务器纳入统一管理视图（列服务器/来源标注）→ `packages/harness-core/src/features/mcp/feature.ts`（`_buildRegistry` 将 ephemeral 标为 `source: 'caller'`）
- [ ] 会话级作用域隔离 — 降级：v2 ephemeral 集合是 Session scope 种子，每个会话一份；新栈 `shared.ephemeral` 是 app 级单例，所有会话共享，无法按会话区分临时服务器集合
- [ ] 撞名遮蔽基线配置 — 决策不做：v2 会话 ephemeral 与基线配置撞名时遮蔽基线；新栈 `loadServers` 合并顺序中 ephemeral 优先级最低（被配置文件覆盖），per-session 撞名遮蔽不实现，影子条目法记录在案

## 结论

未对齐 2 项——会话级隔离降级为 app 级共享注册表；撞名遮蔽明确不做（记录在案）。
