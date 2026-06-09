/**
 * `IMcpService` — daemon-facing MCP server surface.
 *
 * Wraps `ICoreProcessService.rpc.{listMcpServers, reconnectMcpServer}` and adapts
 * the agent-core `McpServerInfo` shape into SCHEMAS §8 `McpServer`. The
 * adapter helper (`toProtocolMcpServer`) is co-located here.
 *
 * **CoreAPI surface used**:
 *   - `core.rpc.listMcpServers({}) => readonly McpServerInfo[]`
 *     (packages/agent-core/src/rpc/core-api.ts:344).
 *   - `core.rpc.reconnectMcpServer({name})` (line 346).
 *
 * **Server identity**: REST.md §3.8 uses `{mcp_server_id}` in the path;
 * agent-core surfaces only `name`. We treat name-as-id at the wire boundary
 * (stable within a daemon process lifetime).
 *
 * **Error model**:
 *   - `MCP_SERVER_NOT_FOUND` (40408) is raised by the impl via
 *     `McpServerNotFoundError`. The route maps it to envelope code 40408.
 *
 * **Anti-corruption**: imports `@moonshot-ai/agent-core` only for the
 * `createDecorator` / `Disposable` values and the `McpServerInfo` type.
 *
 * **MCP status mapping** (`McpServerInfo.status` → `McpServer.status`):
 *   agent-core 'pending'    → wire 'connecting'
 *   agent-core 'connected'  → wire 'connected'
 *   agent-core 'failed'     → wire 'error'
 *   agent-core 'disabled'   → wire 'disconnected'
 *   agent-core 'needs-auth' → wire 'error'   (last_error carries the hint)
 *
 * **MCP id**: agent-core's `McpServerInfo` has only `name`. We adopt
 * name-as-id at the wire boundary. Both are 1:1 within a daemon process.
 */

import { createDecorator, Disposable } from '@moonshot-ai/agent-core';
import type { McpServerInfo } from '@moonshot-ai/agent-core';
import type {
  McpServer,
  McpServerStatus,
  McpServerTransport,
} from '@moonshot-ai/protocol';

// ---------------------------------------------------------------------------
// Adapter helpers (MCP side of former adapter/tool-adapter.ts)
// ---------------------------------------------------------------------------

function mapMcpStatus(s: McpServerInfo['status']): McpServerStatus {
  switch (s) {
    case 'connected':
      return 'connected';
    case 'pending':
      return 'connecting';
    case 'failed':
      return 'error';
    case 'disabled':
      return 'disconnected';
    case 'needs-auth':
      // Closest wire literal; `last_error` carries the explanatory message.
      return 'error';
  }
}

function mapMcpTransport(t: McpServerInfo['transport']): McpServerTransport {
  // SCHEMAS §8 transport is a superset (adds 'sse'); the two agent-core
  // literals pass through unchanged.
  switch (t) {
    case 'stdio':
      return 'stdio';
    case 'http':
      return 'http';
  }
}

export function toProtocolMcpServer(info: McpServerInfo): McpServer {
  const status = mapMcpStatus(info.status);
  const base: McpServer = {
    // name-as-id: agent-core doesn't surface a separate id; the daemon's
    // REST path uses {mcp_server_id} which we interpret as the name.
    id: info.name,
    name: info.name,
    transport: mapMcpTransport(info.transport),
    status,
    tool_count: info.toolCount,
  };
  // Surface the upstream error message when present. We expose it on every
  // non-healthy status (not just 'error') because 'needs-auth' arrives with
  // `error` carrying the auth-hint URL.
  if (info.error !== undefined && info.error.length > 0) {
    return { ...base, last_error: info.error };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Interface + implementation
// ---------------------------------------------------------------------------

export interface IMcpService {
  readonly _serviceBrand: undefined;

  /** Return all MCP servers known to the in-process KimiCore. */
  list(): Promise<readonly McpServer[]>;

  /**
   * Trigger an MCP server reconnect. Returns `{ restarting: true }` on a
   * successful enqueue. Throws `McpServerNotFoundError` (→ 40408) when the
   * server id is not registered.
   */
  restart(serverId: string): Promise<{ restarting: true }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IMcpService = createDecorator<IMcpService>('mcpService');

/**
 * Sentinel — daemon's route layer catches this and maps to envelope `code:
 * 40408 mcp.server_not_found`. Other thrown errors fall through to
 * `installErrorHandler` (→ 50001).
 */
export class McpServerNotFoundError extends Error {
  readonly serverId: string;
  constructor(serverId: string) {
    super(`mcp server ${serverId} does not exist`);
    this.name = 'McpServerNotFoundError';
    this.serverId = serverId;
  }
}

void IMcpService;
