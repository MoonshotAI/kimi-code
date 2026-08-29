/**
 * The inline/reconnect MCP config validation for the v2 client's
 * session-level MCP methods (`sdk-rpc-client-v2.ts`), which ride the
 * session's own connection manager and have no engine service behind them.
 * The validators keep v1's exact error text for the session RPC paths, and
 * validation keeps using v1's own `McpServerConfigSchema`.
 *
 * Persisting session-level adds to the user-level `mcp.json` no longer
 * happens here: `addSessionMcpServer`'s `persist: true` path writes through
 * the engine's App-scope `IMcpConfigStore` — the single writer of that file —
 * and the unified management plane (CRUD facade, connection probe,
 * inspection, OAuth orchestration) delegates to the engine's
 * `IMcpManagementService`.
 */
import {
  ErrorCodes,
  KimiError,
  McpServerConfigSchema,
  type GlobalMcpServerConfig,
  type McpServerConfig,
} from '@moonshot-ai/agent-core';

/** Byte-identical port of v1's `mcpConfigWithoutName`. */
export function mcpConfigWithoutName(server: GlobalMcpServerConfig): McpServerConfig {
  const { name: _name, ...config } = server;
  return config;
}

/**
 * Byte-identical port of v1's inline-server validation (the `server` branch
 * of `resolveMcpTestTarget`, shared with `addSessionMcpServer`): the schema
 * strips unknown keys such as a stray `name`, so the name is re-attached.
 */
export function parseInlineMcpServer(server: GlobalMcpServerConfig): GlobalMcpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(server);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server "${server.name}": ${parsed.error.message}`,
    );
  }
  return { name: server.name, ...parsed.data };
}

/**
 * Byte-identical port of v1's reconnect-config validation
 * (`SessionAPIImpl.reconnectMcpServer`): same schema strip, nameless result.
 */
export function parseReconnectMcpServerConfig(
  name: string,
  config: GlobalMcpServerConfig,
): McpServerConfig {
  const parsed = McpServerConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `Invalid MCP server config for "${name}": ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export function normalizeServerName(name: string): string {
  const normalized = name.trim();
  if (normalized.length > 0) return normalized;
  throw new KimiError(ErrorCodes.REQUEST_INVALID, 'MCP server name cannot be empty');
}
