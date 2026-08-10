/**
 * `/tools` + `/mcp/servers` REST routes — server-v2 port.
 *
 * 2 endpoints (the engine-mode subset of REST.md §3.8):
 *
 *   GET  /tools        query: {session_id?}    data: {tools: ToolDescriptor[]}
 *   GET  /mcp/servers  -                       data: {servers: McpServer[]}
 *
 * `POST /mcp/servers/{mcp_server_id}:restart` was retired with the v2 engine:
 * the Rust engine owns MCP servers per session and exposes no restart RPC.
 *
 * Engine mode: the engine owns the toolset and MCP servers per session
 * (`session/list_tools` / `session/list_mcp_servers`). Both endpoints fall
 * back to the most-recent engine session (mirroring the retired v2
 * resolveEffectiveAgent fallback) and project the engine models onto the
 * protocol's `ToolDescriptor` / `McpServer` wire shapes.
 *
 * **Model projection**:
 *   - Tool `source`: always `builtin` (the engine's native toolset + goal
 *     tools; the v2 user/builtin/mcp source distinction was retired with it).
 *   - Tool `input_schema`: carried from the engine definition when present.
 *   - MCP `status`: engine `connected`→`connected`, `pending`/
 *     `pending-approval`→`connecting`, `failed`/`needs-auth`→`error`,
 *     `disabled`→`disconnected`.
 *   - MCP `last_error`: carried from the engine entry when non-empty.
 *
 * **Resolution**: no session live → both GETs answer an empty list.
 */

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
} from '../protocol/rest-tool';
import type { McpServer } from '../protocol/tool';
import type { EngineMcpServerInfo } from '@moonshot-ai/kimi-agent/rust-loop';
import type { RustSessionService } from '../services/rustSession/rustSessionService';

interface ToolsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerToolsRoutes(
  app: ToolsRouteHost,
  rustSession?: RustSessionService,
): void {
  // GET /tools ----------------------------------------------------------
  const listToolsRoute = defineRoute(
    {
      method: 'GET',
      path: '/tools',
      querystring: listToolsQuerySchema,
      success: { data: listToolsResponseSchema },
      description: 'List available tools',
      tags: ['tools'],
    },
    async (req, reply) => {
      // Rust-engine mode: the engine answers with its own native toolset +
      // goal tools (stage 3d) — no v2 agent-scoped registry.
      if (rustSession !== undefined) {
        const sessions = rustSession.listSessions();
        const latest = sessions.at(-1);
        const tools =
          latest === undefined
            ? []
            : (((await rustSession.listTools(latest.id)) as
                | { tools: Array<{ name: string; description: string; input_schema: unknown }> }
                | null)?.tools ?? []).map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.input_schema ?? { type: 'object' },
                source: 'builtin',
              }));
        reply.send(okEnvelope({ tools }, req.id));
        return;
      }
      // Unreachable: the v2 agent-scoped registry was retired with the v2
      // engine — the session backend is always the Rust engine.
    },
  );
  app.get(
    listToolsRoute.path,
    listToolsRoute.options,
    listToolsRoute.handler as Parameters<ToolsRouteHost['get']>[2],
  );

  // GET /mcp/servers ----------------------------------------------------
  const listMcpServersRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers',
      success: { data: listMcpServersResponseSchema },
      description: 'List configured MCP servers',
      tags: ['tools'],
    },
    async (req, reply) => {
      // Rust-engine mode: MCP servers live in the engine session (per
      // session/list_mcp_servers). Fall back to the most-recent engine
      // session, mirroring the retired v2 resolveEffectiveAgent fallback.
      if (rustSession !== undefined) {
        const sessions = rustSession.listSessions();
        const latest = sessions.at(-1);
        const servers =
          latest === undefined
            ? []
            : ((await rustSession.listMcpServers(latest.id)) as
                | { servers: EngineMcpServerInfo[] }
                | null)?.servers?.map(toEngineMcpServer) ?? [];
        reply.send(okEnvelope({ servers }, req.id));
        return;
      }
      // Unreachable: the v2 agent-scoped MCP service was retired with the
      // v2 engine — the session backend is always the Rust engine.
    },
  );
  app.get(
    listMcpServersRoute.path,
    listMcpServersRoute.options,
    listMcpServersRoute.handler as Parameters<ToolsRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// Projection — engine MCP models → protocol wire shapes (see module header).
// ---------------------------------------------------------------------------

/** Map an engine MCP status onto the v1 wire enum (engine states are a
 *  superset: pending/pending-approval/needs-auth have no v1 counterpart). */
function mapEngineMcpStatus(status: EngineMcpServerInfo['status']): McpServer['status'] {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'pending':
    case 'pending-approval':
      return 'connecting';
    case 'failed':
    case 'needs-auth':
      return 'error';
    case 'disabled':
      return 'disconnected';
  }
}

/** Project an engine MCP view onto the v1 `McpServer` wire shape. */
function toEngineMcpServer(entry: EngineMcpServerInfo): McpServer {
  const base: McpServer = {
    id: entry.name,
    name: entry.name,
    transport: entry.transport,
    status: mapEngineMcpStatus(entry.status),
    tool_count: entry.tool_count,
  };
  if (entry.error !== null && entry.error !== undefined && entry.error.length > 0) {
    return { ...base, last_error: entry.error };
  }
  return base;
}
