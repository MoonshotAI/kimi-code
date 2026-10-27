# IWorkspaceMcpConfigService（workspaceMcpConfigService）

- v2: `packages/agent-core-v2/src/workspace/workspaceMcpConfig/workspaceMcpConfig.ts`（约 31 行，读 interface 与 workspaceMcpConfigService.ts 实现得出）
- 新架构: `packages/harness-core/src/features/mcp/config/loader.ts`（loadMcpServers）+ `packages/harness-core/src/features/mcp/feature.ts`

## 能力对照

- [x] servers() 多层合并（用户 ~/mcp.json → 项目根 .mcp.json → .kimi-code/mcp.json，文件层覆盖插件层）→ `packages/harness-core/src/features/mcp/config/loader.ts` 的 loadMcpServers（props.servers → user → projectRoot → project 依序覆盖），插件层经 `McpServerSources` 贡献点合并（feature.ts loadServers）
- [x] 项目层配置的 trust 门控（未信任不加载 project 两层）→ loadMcpServers 的 `trusted` 入参（createMcp props.trusted，宿主注入）
- [x] tunables()（startupTimeoutMs/toolTimeoutMs/defaultDeferred）→ `packages/harness-core/src/features/mcp/config/section.ts` 的 MCP_CONFIG_SECTION，经 resolveDefaultTimeouts 供管理器使用
- [x] 管理写入后重载生效 → `packages/harness-core/src/features/mcp/feature.ts` + `McpUserConfigStore` 写后调 reloadServers
- [ ] mcp 配置文件的 fswatch 自动重载（v2 监视 user/project 两类 mcp.json，200ms 防抖）— 未迁：新栈 reload 仅由 source onDidChange、管理写入或显式 `McpRef.reload()` 触发
- [ ] onDidChange 配置 diff 事件（upsert/remove + IWaitUntil 阻塞应用）— 无等价：新栈对外只有 `mcp.server.state` 连接状态事件，无配置级 upsert/remove 通知，亦无 waitUntil 参与点
- [ ] trust 变更联动重载（v2 订阅 IWorkspaceTrust.onDidChange 重载文件层）— 降级：新栈 trusted 为创建期静态 prop，信任变化不会触发 project 层补载

## 结论

未对齐 3 项——三层合并、trust 门控与 tunables 已对齐；文件监视、配置 diff 事件与 trust 动态联动未迁。
