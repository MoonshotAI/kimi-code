import {
  ErrorCodes,
  IAgentMcpService,
  ISessionIndex,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  getLiveSessionById,
  Error2,
  type Scope,
  type ToolInfo,
  type ToolSource,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import { ErrorCode } from '../protocol/error-codes';
import {
  listMcpServersResponseSchema,
  listToolsQuerySchema,
  listToolsResponseSchema,
  restartMcpServerResultSchema,
} from '../protocol/rest-tool';
import type { McpServer, ToolDescriptor } from '../protocol/tool';
import { parseActionSuffix } from './action-suffix';

const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';

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

  const listMcpServersRoute = defineRoute(
    {
      method: 'GET',
      path: '/mcp/servers',
      success: { data: listMcpServersResponseSchema },
      description: 'List configured MCP servers',
      tags: ['tools'],
    },
    async (req, reply) => {
      const agent = await resolveEffectiveAgent(core, undefined);
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
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }

      const agent = await resolveEffectiveAgent(core, undefined);
      if (agent === undefined) {
        reply.send(mcpServerNotFound(parsed.id, req.id));
        return;
      }
      const mcp = agent.accessor.get(IAgentMcpService);
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

async function resolveEffectiveAgent(core: Scope, sessionId: string | undefined) {
  const sid = sessionId ?? (await mostRecentSessionId(core));
  if (sid === undefined) return undefined;
  const session = getLiveSessionById(core.accessor, sid);
  if (session === undefined) return undefined;
  return ensureMainAgent(session);
}

async function mostRecentSessionId(core: Scope): Promise<string | undefined> {
  const page = await core.accessor.get(ISessionIndex).listRecent({});
  const [first, ...rest] = page.items;
  if (first === undefined) return undefined;
  let newest = first;
  for (const item of rest) {
    if (item.createdAt > newest.createdAt) newest = item;
  }
  return newest.id;
}

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
    case 'connected':
      return 'connected';
    case 'disabled':
      return 'disconnected';
    case 'removed':
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

function mcpServerNotFound(serverId: string, requestId: string): unknown {
  return errEnvelope(
    ErrorCode.MCP_SERVER_NOT_FOUND,
    `MCP server ${serverId} does not exist`,
    requestId,
  );
}

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
