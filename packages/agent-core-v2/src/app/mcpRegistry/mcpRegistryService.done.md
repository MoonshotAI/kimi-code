# IMcpRegistryService（mcpRegistryService）

- v2: `packages/agent-core-v2/src/app/mcpRegistry/mcpRegistry.ts`（约 38 行 interface；仅被 IMcpManagementService 消费）
- 新架构: `packages/harness-core/src/features/mcp/feature.ts`（`_buildRegistry`，结构性合并进管理面）

## 能力对照

- [x] list/get（global+plugin+caller 三源注册表，含 origin/mutable 标记）→ feature.ts 的 `_buildRegistry`
- [x] resolveRuntimeTarget（按名字解析运行时目标配置）→ feature.ts 的 `_resolveTestTarget`/`_resolveServer` 与 `packages/harness-core/src/features/mcp/feature.ts` 的 loadServers
- [x] 三层 mcp.json 合并（user ~/mcp.json、项目根 .mcp.json、.kimi-code/mcp.json，信任门控）→ `packages/harness-core/src/features/mcp/config/loader.ts` 的 loadMcpServersDetailed

## 结论

全部对齐——独立 registry 服务结构性合并进 mcp 管理面，三源合并与运行时解析能力完整。
