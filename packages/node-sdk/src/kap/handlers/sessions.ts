import type { Session as ProtocolSession } from '@moonshot-ai/protocol';

import { toCreateSessionBody, toSessionSummary } from '../mappers';
import type { CoreApiHandlerMap } from '../types';

interface SessionPayload {
  readonly sessionId: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export const sessionHandlers: CoreApiHandlerMap = {
  createSession: async (payload, ctx) => {
    const body = toCreateSessionBody(payload as never);
    const session = await ctx.http.post<ProtocolSession>('/sessions', body);
    return toSessionSummary(session);
  },

  listSessions: async (_payload, ctx) => {
    const page = await ctx.http.get<{ items: ProtocolSession[]; has_more: boolean }>('/sessions');
    return page.items.map(toSessionSummary);
  },

  forkSession: async (payload, ctx) => {
    const { sessionId, title, metadata } = payload as SessionPayload;
    const session = await ctx.http.post<ProtocolSession>(`/sessions/${sessionId}:fork`, {
      title,
      metadata,
    });
    return toSessionSummary(session);
  },

  renameSession: async (payload, ctx) => {
    const { sessionId, title } = payload as SessionPayload;
    await ctx.http.post(`/sessions/${sessionId}/profile`, { title });
  },

  updateSessionMetadata: async (payload, ctx) => {
    const { sessionId, metadata } = payload as SessionPayload;
    await ctx.http.post(`/sessions/${sessionId}/profile`, { metadata });
  },

  getSessionMetadata: async (payload, ctx) => {
    const { sessionId } = payload as SessionPayload;
    const session = await ctx.http.get<ProtocolSession>(`/sessions/${sessionId}`);
    return session.metadata;
  },

  closeSession: async (payload, ctx) => {
    const { sessionId } = payload as SessionPayload;
    // KAP only has :archive (close + on-disk archive). Acceptable per research §6.2/§8.7.
    await ctx.http.post(`/sessions/${sessionId}:archive`, {});
  },

  archiveSession: async (payload, ctx) => {
    const { sessionId } = payload as SessionPayload;
    await ctx.http.post(`/sessions/${sessionId}:archive`, {});
  },
};
