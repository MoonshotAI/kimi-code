import {
  ISessionIndex,
  IAgentToolRegistryService,
  IAgentToolPolicyService,
  getLiveSessionById,
  resumeSessionById,
  type ISessionScopeHandle,
  type Scope,
  type ToolInfo,
  type ToolSource,
} from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ensureMainAgent } from '../transport/mainAgent';
import {
  listToolsQuerySchema,
  listToolsResponseSchema,
} from '../protocol/rest-tool';
import type { ToolDescriptor } from '../protocol/tool';

const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';

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
}

async function resolveEffectiveAgent(core: Scope, sessionId: string | undefined) {
  let session: ISessionScopeHandle | undefined;
  if (sessionId !== undefined) {
    session = await resumeSessionById(core.accessor, sessionId);
  } else {
    const recent = await mostRecentSessionId(core);
    session = recent === undefined ? undefined : getLiveSessionById(core.accessor, recent);
  }
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
