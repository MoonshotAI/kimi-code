import { MAIN_AGENT_ID, useApp } from '@moonshot-ai/agent-core';

import {
  SessionSpaceError,
  useCreateSession,
  useSessionSpace,
  useUpdateSession,
  type OpenSessionInput,
  type SessionRecord,
} from '#/host/session';

import { useHttpRoute } from '../feature';
import { parseActionSuffix } from '../route/action-suffix';
import { ErrorCode, param, readAgentId, sendErr, sendFacadeErr, sendOk } from '../route/http';

export interface SessionView {
  readonly id: string;
  readonly title?: string;
  readonly workspace_id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly agent_ids: string[];
}

type SessionAction = 'fork' | 'abort' | 'pause' | 'continue' | 'delete' | 'update';

const SESSION_ACTIONS: readonly SessionAction[] = ['fork', 'abort', 'pause', 'continue', 'delete', 'update'];

export function useSessionRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.list',
    method: 'GET',
    path: `${prefix}/sessions`,
    handler: async (request, response) => {
      const app = useApp();
      const space = useSessionSpace();
      sendOk(request, response, {
        items: (await space.list()).map((record) => sessionView(record, app.get(record.id)?.list() ?? [])),
        has_more: false,
      });
    },
  });

  useHttpRoute({
    id: 'sessions.create',
    method: 'POST',
    path: `${prefix}/sessions`,
    handler: async (request, response) => {
      const createSession = useCreateSession();
      try {
        const session = await createSession(readSessionInput(request.body));
        sendOk(request, response, { id: session.sessionId, agent_ids: session.list() }, 201);
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'sessions.get',
    method: 'GET',
    path: `${prefix}/sessions/:session_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
        return;
      }
      const app = useApp();
      const space = useSessionSpace();
      const record = await space.get(sessionId);
      if (record === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      sendOk(request, response, sessionView(record, app.get(record.id)?.list() ?? []));
    },
  });

  useHttpRoute({
    id: 'sessions.patch',
    method: 'PATCH',
    path: `${prefix}/sessions/:session_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
        return;
      }
      const app = useApp();
      const space = useSessionSpace();
      const updateSession = useUpdateSession();
      try {
        if ((await space.get(sessionId)) === undefined) {
          throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
        }
        sendOk(
          request,
          response,
          sessionView(await updateSession(sessionId, readSessionInput(request.body)), app.get(sessionId)?.list() ?? []),
        );
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'sessions.delete',
    method: 'DELETE',
    path: `${prefix}/sessions/:session_id`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
        return;
      }
      const app = useApp();
      const space = useSessionSpace();
      try {
        if ((await space.get(sessionId)) === undefined) {
          throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
        }
        if (app.get(sessionId) !== undefined) {
          await app.close(sessionId);
        }
        await space.delete(sessionId);
        sendOk(request, response, { deleted: true });
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'sessions.action',
    method: 'POST',
    path: `${prefix}/sessions/:tail`,
    handler: async (request, response) => {
      const tail = param(request, 'tail');
      if (tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required', 400);
        return;
      }
      const parsed = parseActionSuffix({
        tail,
        allowedActions: SESSION_ACTIONS,
        resourceLabel: 'session',
      });
      if (parsed.kind !== 'action') {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${tail}`,
          400,
        );
        return;
      }
      const app = useApp();
      const space = useSessionSpace();
      const createSession = useCreateSession();
      const updateSession = useUpdateSession();
      try {
        if (parsed.action === 'fork') {
          if ((await space.get(parsed.id)) === undefined) {
            throw new SessionSpaceError('not-found', `session ${parsed.id} does not exist`);
          }
          const session = await createSession({ ...readSessionInput(request.body), from: parsed.id });
          sendOk(request, response, { id: session.sessionId, agent_ids: session.list() }, 201);
          return;
        }
        if (parsed.action === 'delete') {
          if ((await space.get(parsed.id)) === undefined) {
            throw new SessionSpaceError('not-found', `session ${parsed.id} does not exist`);
          }
          if (app.get(parsed.id) !== undefined) {
            await app.close(parsed.id);
          }
          await space.delete(parsed.id);
          sendOk(request, response, { deleted: true });
          return;
        }
        if (parsed.action === 'update') {
          if ((await space.get(parsed.id)) === undefined) {
            throw new SessionSpaceError('not-found', `session ${parsed.id} does not exist`);
          }
          sendOk(
            request,
            response,
            sessionView(await updateSession(parsed.id, readSessionInput(request.body)), app.get(parsed.id)?.list() ?? []),
          );
          return;
        }
        const session = app.get(parsed.id);
        if (session === undefined) {
          sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${parsed.id} does not exist`, 404);
          return;
        }
        const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
        const agent = session.get(agentId);
        if (agent === undefined) {
          sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
          return;
        }
        if (parsed.action === 'abort') {
          agent.abort();
          sendOk(request, response, { aborted: true });
          return;
        }
        if (parsed.action === 'pause') {
          agent.pause();
          sendOk(request, response, { paused: true });
          return;
        }
        agent.continue();
        sendOk(request, response, { continued: true });
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });
}

function readSessionInput(body: unknown): OpenSessionInput {
  const input: {
    sessionId?: string;
    title?: string;
    workspaceId?: string;
    metadata?: Record<string, unknown>;
  } = {};
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return input;
  }
  const record = body as { [key: string]: unknown };
  if (typeof record['session_id'] === 'string' && record['session_id'].length > 0) {
    input.sessionId = record['session_id'];
  }
  if (typeof record['title'] === 'string') {
    input.title = record['title'];
  }
  if (typeof record['workspace_id'] === 'string' && record['workspace_id'].length > 0) {
    input.workspaceId = record['workspace_id'];
  }
  if (record['metadata'] !== null && typeof record['metadata'] === 'object' && !Array.isArray(record['metadata'])) {
    input.metadata = record['metadata'] as Record<string, unknown>;
  }
  return input;
}

function sessionView(record: SessionRecord, agentIds: readonly string[]): SessionView {
  return {
    id: record.id,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.workspaceId !== undefined ? { workspace_id: record.workspaceId } : {}),
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
    agent_ids: [...agentIds],
  };
}
