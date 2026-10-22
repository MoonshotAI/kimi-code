# IMcpOAuthStore（mcpOAuthStore）

- v2: `packages/agent-core-v2/src/app/mcpConfig/oauthStore.ts`（约 70 行，interface 与实现同文件，均读过）
- 新架构: `packages/harness-core/src/features/mcp/oauth/store.ts`

## 能力对照

- [x] read/write/remove/list 凭证存取（键经 canonical resource 归一化：mcpOAuthStoreKey/canonicalMcpOAuthResource）→ `packages/harness-core/src/features/mcp/oauth/store.ts` 的 McpOAuthStore
- [x] 落盘路径 credentials/mcp → `packages/harness-core/src/features/mcp/feature.ts` 约 88 行 createFileMcpOAuthStore(join(home, 'credentials', 'mcp'))
- [x] 读取失败静默降级（v2 read 捕获异常返回 undefined）与无 home 环境降级 → store.ts 的 createMemoryMcpOAuthStore 兜底

## 结论

全部对齐——OAuth 凭证存储由 features/mcp/oauth/store.ts 承载，路径与降级语义一致。
