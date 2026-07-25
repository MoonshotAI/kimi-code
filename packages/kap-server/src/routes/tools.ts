/**
 * `/tools` + `/mcp/servers*` REST routes — server-v2 port.
 *
 * 3 endpoints (REST.md §3.8), mirroring the v1 server's wire contract
 * (`packages/server/src/routes/tools.ts`):
 *
 *   GET  /tools                                  query: {session_id?}    data: {tools: ToolDescriptor[]}
 *   GET  /mcp/servers                            -                       data: {servers: McpServer[]}
 *   POST /mcp/servers/{mcp_server_id}:restart    body: empty             data: {restarting: true}
 *
 * **Thin wrapper over Agent-scoped services**: `IAgentToolRegistryService.list` /
 * `IAgentToolPolicyService.isToolActive` / `IAgentMcpService.list` /
 * `IAgentMcpService.reconnect` are already exposed on the
 * RPC dispatcher (`/api/v1/debug`). These
 * REST routes borrow them by interface and project their v2 models into the
 * protocol's `ToolDescriptor` / `McpServer` shapes.
 *
 * **Resolution**: v1 serves these from a global singleton that falls back to
 * the most-recent session. v2 has no global tool/MCP state — both services are
 * Agent-scoped — so we reproduce the fallback: `core` → `ISessionIndex` (pick
 * the newest session by `createdAt`, or the explicit `session_id`) →
 * `ISessionLifecycleService` → `IAgentLifecycleService` (the `main` agent) →
 * the service. When no session is live, or the main agent does not exist yet
 * (server-v2 gap G10), the GET endpoints answer an empty list and `:restart`
 * answers `40408`, exactly like v1.
 *
 * **Model projection**:
 *   - Tool `source`: `user`→`skill` (wire name), `builtin`/`mcp` pass through.
 *   - Tool `input_schema`: always `null`, matching v1 (`packages/server`'s
 *     `ToolInfo` carries no JSON schema). v2's registry does expose
 *     `parameters`, but we keep byte-for-byte wire parity with v1.
 *   - Tool `mcp_server_id`: parsed from the qualified name `mcp__<server>__<tool>`
 *     (v2's double-underscore form, not v1's `mcp:<server>:<tool>` colon form).
 *   - Tool `active`: effective availability from `IAgentToolPolicyService.isToolActive`
 *     (bound profile policy ∩ global `[tools]` config ∩ session denylist).
 *     Deliberate v2 extension beyond the v1 wire shape — v1 had no tool gates.
 *   - MCP `status`: `pending`→`connecting`, `connected`→`connected`,
 *     `failed`/`needs-auth`→`error`, `disabled`→`disconnected`.
 *   - MCP `last_error`: carried from `entry.error` when non-empty.
 *
 * **Error mapping**:
 *   - `:restart` of an unknown / unreachable server → `40408 mcp.server_not_found`.
 *   - malformed `{tail}` (bad action, bare id) → `40001 validation.failed`.
 *   - other errors → 50001 via the global `installErrorHandler`.
 *
 * **Anti-corruption**: route resolves `IAgentToolRegistryService` / `IAgentMcpService` via the
 * accessor; no SDK imports.
 */

import {
  ErrorCodes,
  IAgentMcpService,
  ISessionIndex,
  ISessionLifecycleService,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  Error2,
  type Scope,
  type ToolInfo,
  type ToolSource,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
  restartMcpServerResultSchema,
} from '../protocol/rest-tool';
import type { McpServer, ToolDescriptor } from '../protocol/tool';
import { ensureMainAgent } from '../transport/mainAgent';
import { parseActionSuffix } from './action-suffix';

/** v2 MCP tool-name prefix / separator (see `mcp/tool-naming.ts`). */
const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';

/** One entry from the agent's MCP server list (type not re-exported publicly). */
type McpEntry = ReturnType<IAgentMcpService['list']>[number];

interface ToolsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerToolsRoutes(app: ToolsRouteHost, core: Scope): void {
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
      const agent = await resolveEffectiveAgent(core, req.query.session_id);
      if (agent === undefined) {
        reply.send(okEnvelope({ tools: [] }, req.id));
        return;
      }
      const registry = agent.accessor.get(IAgentToolRegistryService);
      const policy = agent.accessor.get(IAgentToolPolicyService);
      const tools = registry
        .list()
        .map((info) => toProtocolTool(info, policy.isToolActive(info.name, info.source)));
      reply.send(okEnvelope({ tools }, req.id));
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
      const agent = await resolveEffectiveAgent(core);
      const servers =
        agent === undefined
          ? []
          : agent.accessor.get(IAgentMcpService).list().map(toProtocolMcpServer);
      reply.send(okEnvelope({ servers }, req.id));
    },
  );
  app.get(
    listMcpServersRoute.path,
    listMcpServersRoute.options,
    listMcpServersRoute.handler as Parameters<ToolsRouteHost['get']>[2],
  );

  // POST /mcp/servers/{mcp_server_id}:restart ---------------------------
  const restartMcpServerRoute = defineRoute(
    {
      method: 'POST',
      path: '/mcp/servers/{tail}',
      success: { data: restartMcpServerResultSchema },
      errors: {
        [ErrorCode.MCP_SERVER_NOT_FOUND]: {},
      },
      description: 'Restart an MCP server by ID',
      tags: ['tools'],
      operationId: 'restartMcpServer',
    },
    async (req, reply) => {
      const { tail } = req.params as { tail: string };
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['restart'] as const,
        resourceLabel: 'mcp_server',
      });
      if (parsed.kind === 'invalid') {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, parsed.reason, req.id));
        return;
      }
      if (parsed.kind === 'bare') {
        // No bare form for /mcp/servers/{id} — only :restart.
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id));
        return;
      }

      const agent = await resolveEffectiveAgent(core);
      if (agent === undefined) {
        reply.send(mcpServerNotFound(parsed.id, req.id));
        return;
      }
      const mcp = agent.accessor.get(IAgentMcpService);
      // Pre-check existence so a missing/idle connection manager (where
      // `reconnect` is a no-op) still reports 40408 for unknown servers.
      if (!mcp.list().some((entry) => entry.name === parsed.id)) {
        reply.send(mcpServerNotFound(parsed.id, req.id));
        return;
      }
      try {
        await mcp.reconnect(parsed.id);
        reply.send(okEnvelope({ restarting: true }, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    restartMcpServerRoute.path,
    restartMcpServerRoute.options,
    restartMcpServerRoute.handler as Parameters<ToolsRouteHost['post']>[2],
  );
}

// ---------------------------------------------------------------------------
// Resolution — walk core → newest session → main agent. Returns `undefined`
// when no session is live or the main agent has not been created yet (gap G10);
// callers translate that into an empty list (GETs) or 40408 (restart).
// ---------------------------------------------------------------------------

async function resolveEffectiveAgent(core: Scope, sessionId?: string) {
  const sid = sessionId ?? (await mostRecentSessionId(core));
  if (sid === undefined) return;
  const session = core.accessor.get(ISessionLifecycleService).get(sid);
  if (session === undefined) return;
  return ensureMainAgent(session);
}

/** Pick the most-recently-created session id, mirroring v1's fallback. */
async function mostRecentSessionId(core: Scope): Promise<string | undefined> {
  const page = await core.accessor.get(ISessionIndex).list({});
  const [first, ...rest] = page.items;
  if (first === undefined) return undefined;
  let newest = first;
  for (const item of rest) {
    if (item.createdAt > newest.createdAt) newest = item;
  }
  return newest.id;
}

// ---------------------------------------------------------------------------
// Projection — v2 models → protocol wire shapes (see module header).
// ---------------------------------------------------------------------------

function mapToolSource(source: ToolSource): ToolDescriptor['source'] {
  switch (source) {
    case 'builtin':
      return 'builtin';
    case 'user':
      return 'skill';
    case 'mcp':
      return 'mcp';
  }
}

/** Extract the MCP server id from a qualified `mcp__<server>__<tool>` name. */
function parseMcpServerId(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_NAME_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_NAME_PREFIX.length);
  const sep = rest.indexOf(MCP_NAME_SEPARATOR);
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

function toProtocolTool(info: ToolInfo, active: boolean): ToolDescriptor {
  const source = mapToolSource(info.source);
  const base: ToolDescriptor = {
    name: info.name,
    description: info.description,
    input_schema: null,
    source,
    active,
  };
  if (source === 'mcp') {
    const serverId = parseMcpServerId(info.name);
    if (serverId !== undefined) return { ...base, mcp_server_id: serverId };
  }
  return base;
}

function mapMcpStatus(status: McpEntry['status']): McpServer['status'] {
  switch (status) {
    case 'pending':
      return 'connecting';
    case 'pending-approval':
      // Awaiting explicit user trust — not an error, not yet connecting.
      return 'disconnected';
    case 'connected':
      return 'connected';
    case 'disabled':
      return 'disconnected';
    case 'failed':
      return 'error';
    case 'needs-auth':
      return 'error';
  }
}

function toProtocolMcpServer(entry: McpEntry): McpServer {
  const base: McpServer = {
    id: entry.name,
    name: entry.name,
    transport: entry.transport,
    status: mapMcpStatus(entry.status),
    tool_count: entry.toolCount,
  };
  if (entry.error !== undefined && entry.error.length > 0) {
    return { ...base, last_error: entry.error };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------

function mcpServerNotFound(serverId: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.MCP_SERVER_NOT_FOUND,
    `MCP server ${serverId} does not exist`,
    requestId,
  );
}

/**
 * Map a thrown error to the right envelope. `reconnect` surfaces an unknown
 * server as a coded `Error2`; everything else propagates to the global
 * `installErrorHandler` (→ 50001). See module header for the table.
 */
function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof Error2 && err.code === ErrorCodes.MCP_SERVER_NOT_FOUND) {
    reply.send(errEnvelope(ErrorCode.MCP_SERVER_NOT_FOUND, err.message, requestId, err.stack));
    return;
  }
  throw err;
}
