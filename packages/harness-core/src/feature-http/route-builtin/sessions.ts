import {
  MAIN_AGENT_ID,
  SessionSpaceError,
  UndoFeatureError,
  UndoRef,
  useApp,
  type ContentPart,
  type HistoryMessage,
  type OpenSessionInput,
  type SessionHandle,
  type SessionRecord,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import { sessionWorkspaceId, withSessionWorkspace } from '#/features/workspaces/index';

import { useHttpRoute } from '../feature';
import { useSessionAction, useSessionActionRoutes } from '../route/session-action';
import { ErrorCode, param, readAgentId, requestId, sendErr, sendFacadeErr, sendOk } from '../route/http';
import { sessionStatusView } from '../route-features/status';

export interface SessionView {
  readonly id: string;
  readonly title?: string;
  readonly workspace_id?: string;
  readonly metadata?: Record<string, unknown>;
  readonly archived?: boolean;
  readonly archived_at?: string;
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  readonly agent_ids: string[];
}

export function useSessionRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.list',
    method: 'GET',
    path: `${prefix}/sessions`,
    handler: async (request, response) => {
      const app = useApp();
      const space = app.space;
      sendOk(request, response, {
        items: (await space.list()).map((record) => sessionView(record, app.get(record.id))),
        has_more: false,
      });
    },
  });

  useHttpRoute({
    id: 'sessions.create',
    method: 'POST',
    path: `${prefix}/sessions`,
    handler: async (request, response) => {
      const app = useApp();
      try {
        const session = await app.open(readSessionInput(request.body));
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
      const space = app.space;
      const record = await space.get(sessionId);
      if (record === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      sendOk(request, response, sessionView(record, app.get(record.id)));
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
      try {
        if ((await app.space.get(sessionId)) === undefined) {
          throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
        }
        sendOk(
          request,
          response,
          sessionView(await app.updateSession(sessionId, readSessionInput(request.body)), app.get(sessionId)),
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
      try {
        await app.delete(sessionId);
        sendOk(request, response, { deleted: true });
      } catch (error) {
        if (sendFacadeErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useSessionActionRoutes(prefix);

  useSessionAction('fork', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      if ((await app.space.get(sessionId)) === undefined) {
        throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
      }
      const session = await app.open({ ...readSessionInput(request.body), from: sessionId });
      sendOk(request, response, { id: session.sessionId, agent_ids: session.list() }, 201);
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('abort', ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = app.get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      agent.abort();
      sendOk(request, response, { aborted: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('pause', ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = app.get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      agent.pause();
      sendOk(request, response, { paused: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('continue', ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const session = app.get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      agent.continue();
      sendOk(request, response, { continued: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('delete', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      await app.delete(sessionId);
      sendOk(request, response, { deleted: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('update', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      if ((await app.space.get(sessionId)) === undefined) {
        throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
      }
      sendOk(
        request,
        response,
        sessionView(await app.updateSession(sessionId, readSessionInput(request.body)), app.get(sessionId)),
      );
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('undo', async ({ sessionId, body, request, response }) => {
    const app = useApp();
    try {
      const session = app.get(sessionId);
      if (session === undefined) {
        sendErr(request, response, ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, 404);
        return;
      }
      const agentId = readAgentId(request) ?? MAIN_AGENT_ID;
      const agent = session.get(agentId);
      if (agent === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      const undo = agent.resolve(UndoRef);
      if (undo === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SESSION_UNDO_UNAVAILABLE,
          'session undo is unavailable (undo feature is not installed)',
          409,
        );
        return;
      }
      try {
        await undo.undo(body.count ?? 1);
      } catch (error) {
        if (error instanceof UndoFeatureError) {
          if (error.code === 'invalid-count') {
            sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message, 400);
            return;
          }
          response.status(409).json({
            code: ErrorCode.SESSION_UNDO_UNAVAILABLE,
            msg: error.message,
            data: undoErrorDetails(error),
            request_id: requestId(request),
          });
          return;
        }
        throw error;
      }
      const history = session.stores.get(agentId)?.getState().history ?? [];
      const status = await sessionStatusView(session);
      if (status === undefined) {
        sendErr(request, response, ErrorCode.AGENT_NOT_FOUND, `agent ${agentId} does not exist`, 404);
        return;
      }
      sendOk(request, response, {
        messages: pageUndoMessages(sessionId, history, body.pageSize),
        status,
      });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });

  useSessionAction('archive', async ({ sessionId, request, response }) => {
    const app = useApp();
    try {
      const record = await app.space.get(sessionId);
      if (record === undefined) {
        throw new SessionSpaceError('not-found', `session ${sessionId} does not exist`);
      }
      await app.updateSession(sessionId, {
        metadata: { ...record.metadata, archived: true, archived_at: new Date().toISOString() },
      });
      sendOk(request, response, { archived: true });
    } catch (error) {
      if (sendFacadeErr(request, response, error)) return;
      throw error;
    }
  });
}

function readSessionInput(body: unknown): OpenSessionInput {
  const input: {
    sessionId?: string;
    title?: string;
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
  if (record['metadata'] !== null && typeof record['metadata'] === 'object' && !Array.isArray(record['metadata'])) {
    input.metadata = record['metadata'] as Record<string, unknown>;
  }
  if (typeof record['workspace_id'] === 'string' && record['workspace_id'].length > 0) {
    input.metadata = withSessionWorkspace(input.metadata, record['workspace_id']);
  }
  return input;
}

function sessionView(record: SessionRecord, live: SessionHandle | undefined): SessionView {
  const archivedAt = record.metadata?.['archived_at'];
  const workspaceId = sessionWorkspaceId(record);
  return {
    id: record.id,
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    ...(record.metadata !== undefined ? { metadata: record.metadata } : {}),
    archived: record.metadata?.['archived'] === true ? true : undefined,
    archived_at: typeof archivedAt === 'string' ? archivedAt : undefined,
    last_turn_reason: live?.status().lastTurnReason,
    agent_ids: [...(live?.list() ?? [])],
  };
}

function undoErrorDetails(error: UndoFeatureError): { requested?: number; undoable?: number } | null {
  if (error.requested === undefined && error.undoable === undefined) return null;
  return { requested: error.requested, undoable: error.undoable };
}

interface UndoMessageView {
  readonly id: string;
  readonly session_id: string;
  readonly role: string;
  readonly content: readonly unknown[];
  readonly created_at: string;
  readonly metadata?: { readonly origin: unknown };
}

const DEFAULT_UNDO_MESSAGE_PAGE_SIZE = 50;
const MAX_UNDO_MESSAGE_PAGE_SIZE = 100;

function pageUndoMessages(
  sessionId: string,
  history: readonly HistoryMessage[],
  requestedPageSize: number | undefined,
): { readonly items: readonly UndoMessageView[]; readonly has_more: boolean } {
  const pageSize = Math.min(
    Math.max(requestedPageSize ?? DEFAULT_UNDO_MESSAGE_PAGE_SIZE, 1),
    MAX_UNDO_MESSAGE_PAGE_SIZE,
  );
  const all = history.map((entry, index) => toWireMessage(sessionId, index, entry));
  const desc = all.toReversed();
  return {
    items: desc.slice(0, pageSize),
    has_more: desc.length > pageSize,
  };
}

function toWireMessage(sessionId: string, index: number, entry: HistoryMessage): UndoMessageView {
  const origin = (entry.meta as { origin?: unknown } | undefined)?.origin;
  return {
    id: messageIdOf(entry) ?? deriveMessageId(sessionId, index),
    session_id: sessionId,
    role: entry.message.role,
    content: wireContent(entry),
    created_at: createdAtOf(entry, index),
    metadata: origin === undefined ? undefined : { origin },
  };
}

function wireContent(entry: HistoryMessage): unknown[] {
  const message = entry.message;
  const visible = message.content.filter((part) => part.type !== 'think' || part.hidden !== true);
  if (message.role === 'tool') {
    const hasMediaPart = visible.some((part) => part.type !== 'text' && part.type !== 'think');
    const output = hasMediaPart
      ? visible.map((part) => mapContentPart(part))
      : visible.map((part) => (part.type === 'text' ? part.text : '')).join('');
    return [
      {
        type: 'tool_result',
        tool_call_id: message.toolCallId,
        output,
        is_error: (entry.meta as ToolMeta | undefined)?.isError === true ? true : undefined,
      },
    ];
  }
  const base: unknown[] = visible.map((part) => mapContentPart(part));
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) {
      let input: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          input = JSON.parse(call.arguments);
        } catch {
          input = call.arguments;
        }
      }
      base.push({ type: 'tool_use', tool_call_id: call.id, tool_name: call.name, input });
    }
  }
  return base;
}

function mapContentPart(part: ContentPart): unknown {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return part.encrypted === undefined
        ? { type: 'thinking', thinking: part.think }
        : { type: 'thinking', thinking: part.think, signature: part.encrypted };
    case 'image_url': {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      return match === null
        ? { type: 'image', source: { kind: 'url', url: part.imageUrl.url }, name: part.imageUrl.name }
        : {
            type: 'image',
            source: { kind: 'base64', media_type: match[1], data: match[2] },
            name: part.imageUrl.name,
          };
    }
    case 'audio_url':
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'video_url': {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      return match === null
        ? { type: 'video', source: { kind: 'url', url: part.videoUrl.url }, name: part.videoUrl.name }
        : {
            type: 'video',
            source: { kind: 'base64', media_type: match[1], data: match[2] },
            name: part.videoUrl.name,
          };
    }
  }
}

function deriveMessageId(sessionId: string, index: number): string {
  return `msg_${sessionId}_${String(index).padStart(6, '0')}`;
}

function messageIdOf(entry: HistoryMessage): string | undefined {
  const meta = entry.meta as { messageId?: unknown; userMessageId?: unknown } | undefined;
  const raw = meta?.messageId ?? meta?.userMessageId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

function createdAtOf(entry: HistoryMessage, index: number): string {
  const raw = (entry.meta as { createdAt?: unknown } | undefined)?.createdAt;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(index).toISOString();
}
