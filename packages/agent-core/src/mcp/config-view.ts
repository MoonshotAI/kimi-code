/**
 * Wire-facing view of an MCP server's effective config.
 *
 * The literal values of secret-bearing fields — stdio `env` and remote
 * `headers` — are replaced by their sorted key lists: they may carry API keys
 * or Authorization tokens, and status/list payloads (session MCP entries,
 * the app-level inspection surface) must never disclose them to SDK
 * consumers. Internal reconciliation keeps using the full `McpServerConfig`.
 */

import type { McpServerConfig } from '#/config/schema';

export type McpServerConfigView =
  | (Omit<Extract<McpServerConfig, { readonly transport: 'stdio' }>, 'env'> & {
      readonly envKeys?: readonly string[];
    })
  | (Omit<Exclude<McpServerConfig, { readonly transport: 'stdio' }>, 'headers'> & {
      readonly headerKeys?: readonly string[];
    });

/** Project a full effective config into its wire-facing view. */
export function toMcpServerConfigView(config: McpServerConfig): McpServerConfigView {
  if (config.transport === 'stdio') {
    const { env, ...safe } = config;
    return env === undefined ? safe : { ...safe, envKeys: Object.keys(env).toSorted() };
  }
  const { headers, ...safe } = config;
  return headers === undefined ? safe : { ...safe, headerKeys: Object.keys(headers).toSorted() };
}
