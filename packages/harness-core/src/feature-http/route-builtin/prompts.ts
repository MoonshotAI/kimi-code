import { useApp } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry } from '@moonshot-ai/agent-core/history/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { useHttpRoute } from '../scope';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, readAgentId, readUserMessage, sendErr, sendOk } from '../route/http';
import { ensureSessionAgent, resumeSession } from '../route/resume-session';

export function usePromptRoutes(prefix: string): void {
  const app = useApp();
  useHttpRoute({
    id: 'prompts.submit',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/prompts`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const message = readUserMessage(request.body);
      if (message === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'content is required');
        return;
      }
      const body = request.body as { prompt_id?: unknown };
      const promptId = typeof body['prompt_id'] === 'string' ? body['prompt_id'] : undefined;
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.agents.get(agentId) ?? (await ensureSessionAgent(app, session, agentId));
      agent.loop.submit(
        createUserEntry(message, {
          source: 'input',
          promptId,
          origin: { kind: 'user' },
          tracked: true,
        }),
      );
      sendOk(request, response, {
        prompt_id: promptId,
        agent_id: agent.id,
        submitted: true,
      });
    },
  });

  useHttpRoute({
    id: 'prompts.steerMany',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/prompts:action`,
    handler: async (request, response) => {
      const raw = param(request, 'action');
      const action = raw === undefined ? undefined : raw.replace(/^:+/, '');
      if (action !== 'steer') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${raw ?? ''}`,
        );
        return;
      }
      const ids = readPromptIds(request.body);
      if (ids === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'prompt_ids is required');
        return;
      }
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
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.agents.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      agent.loop.steer(ids);
      sendOk(request, response, { steered: true, prompt_ids: ids });
    },
  });

  useHttpRoute({
    id: 'prompts.action',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/prompts/:tail`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      const tail = param(request, 'tail');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'prompt_id is required');
        return;
      }
      const parsed = parseActionSuffix({
        tail,
        allowedActions: ['abort', 'steer'] as const,
        resourceLabel: 'prompt',
      });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
        );
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.agents.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`);
        return;
      }
      if (parsed.action === 'abort') {
        agent.loop.cancel(parsed.id);
        sendOk(request, response, { aborted: true });
        return;
      }
      agent.loop.steer([parsed.id]);
      sendOk(request, response, { steered: true, prompt_ids: [parsed.id] });
    },
  });

  useHttpRoute({
    id: 'prompts.notify',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/notify`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const message = readUserMessage(request.body);
      if (message === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'content is required');
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.agents.get(agentId) ?? (await ensureSessionAgent(app, session, agentId));
      agent.loop.notify(createUserEntry(message, { source: 'input' }));
      sendOk(request, response, { notified: true, agent_id: agent.id });
    },
  });

  useHttpRoute({
    id: 'prompts.remind',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/remind`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const body = request.body;
      const key =
        body !== null && typeof body === 'object' && !Array.isArray(body)
          ? (body as { key?: unknown })['key']
          : undefined;
      if (key !== undefined && (typeof key !== 'string' || key.length === 0)) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'key must be a non-empty string');
        return;
      }
      const message = readUserMessage(request.body);
      if (message === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'content is required');
        return;
      }
      const session = await resumeSession(app, sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.agents.get(agentId) ?? (await ensureSessionAgent(app, session, agentId));
      agent.loop.remind(createUserEntry(message, key === undefined ? {} : { key }));
      sendOk(request, response, { reminded: true, key, agent_id: agent.id });
    },
  });
}

function readPromptIds(body: unknown): string[] | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }
  const ids = (body as { prompt_ids?: unknown })['prompt_ids'];
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
    return undefined;
  }
  return ids as string[];
}
