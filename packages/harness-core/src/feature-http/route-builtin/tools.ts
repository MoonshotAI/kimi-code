import { useApp } from '@moonshot-ai/agent-core/app/index';
import type { ToolDescription } from '@moonshot-ai/agent-core/llm/message';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { useHttpRoute } from '../scope';
import { sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

const MCP_NAME_PREFIX = 'mcp__';
const MCP_NAME_SEPARATOR = '__';

export interface ToolView {
  readonly name: string;
  readonly description: string;
  readonly input_schema: null;
  readonly source: 'builtin' | 'skill' | 'mcp';
  readonly mcp_server_id?: string;
  readonly active: boolean;
}

export function useToolsRoutes(prefix: string): void {
  const app = useApp();
  useHttpRoute({
    id: 'tools.list',
    method: 'GET',
    path: `${prefix}/tools`,
    handler: async (request, response) => {
      const query = request.query['session_id'];
      const sessionId = typeof query === 'string' && query.length > 0 ? query : [...app.sessions.keys()].at(-1);
      const session =
        sessionId === undefined
          ? undefined
          : await resumeSession(app, sessionId).catch(() => undefined);
      const agent = session?.agents.get(MAIN_AGENT_ID);
      if (session === undefined || agent === undefined) {
        sendOk(request, response, { tools: [] });
        return;
      }
      sendOk(request, response, { tools: (agent.loop.state.profile.tools ?? []).map(toolView) });
    },
  });
}

function parseMcpServerId(toolName: string): string | undefined {
  if (!toolName.startsWith(MCP_NAME_PREFIX)) return undefined;
  const rest = toolName.slice(MCP_NAME_PREFIX.length);
  const sep = rest.indexOf(MCP_NAME_SEPARATOR);
  if (sep <= 0) return undefined;
  return rest.slice(0, sep);
}

function toolView(tool: ToolDescription): ToolView {
  const serverId = parseMcpServerId(tool.name);
  return {
    name: tool.name,
    description: tool.description,
    input_schema: null,
    source: serverId !== undefined ? 'mcp' : 'builtin',
    mcp_server_id: serverId,
    active: true,
  };
}
