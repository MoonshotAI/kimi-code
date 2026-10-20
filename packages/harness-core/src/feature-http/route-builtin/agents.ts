import { useApp } from '@moonshot-ai/agent-core/app/index';

import { useHttpRoute } from '../scope';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import { resumeSession } from '../route/resume-session';

export interface AgentView {
  readonly id: string;
  readonly status?: string;
}

export function useAgentRoutes(prefix: string): void {
  const app = useApp();
  useHttpRoute({
    id: 'agents.list',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/agents`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      sendOk(request, response, {
        items: [...session.agents.keys()].map((id) => ({ id })),
        has_more: false,
      });
    },
  });

  useHttpRoute({
    id: 'agents.get',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/agents/:agent_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      const agentId = param(request, 'agent_id');
      if (sessionId === undefined || agentId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id and agent_id are required');
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agent = session.agents.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      const view: AgentView = {
        id: agent.id,
        status: agent.loop.state.status,
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
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id and agent_id are required');
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      if (session.agents.get(agentId) === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      await session.close(agentId);
      sendOk(request, response, { deleted: true });
    },
  });
}
