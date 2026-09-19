import { useApp } from '@moonshot-ai/agent-core';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';

export interface AgentView {
  readonly id: string;
  readonly status?: string;
}

export function useAgentRoutes(prefix: string): void {
  useHttpRoute({
    id: 'agents.list',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/agents`,
    handler: (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
        return;
      }
      const session = useApp().get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      sendOk(request, response, {
        items: session.list().map((id) => ({ id })),
        has_more: false,
      });
    },
  });

  useHttpRoute({
    id: 'agents.get',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/agents/:agent_id`,
    handler: (request, response) => {
      const sessionId = param(request, 'session_id');
      const agentId = param(request, 'agent_id');
      if (sessionId === undefined || agentId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id and agent_id are required', 400);
        return;
      }
      const session = useApp().get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      const view: AgentView = {
        id: agent.agentId,
        status: agent.snapshot.value?.status,
      };
      sendOk(request, response, view);
    },
  });

  useHttpRoute({
    id: 'agents.delete',
    method: 'DELETE',
    path: `${prefix}/sessions/:session_id/agents/:agent_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      const agentId = param(request, 'agent_id');
      if (sessionId === undefined || agentId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id and agent_id are required', 400);
        return;
      }
      const session = useApp().get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      if (session.get(agentId) === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      await session.close(agentId);
      sendOk(request, response, { deleted: true });
    },
  });
}
