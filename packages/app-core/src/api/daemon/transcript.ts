import {
  transcriptResponseSchema,
  type AgentTranscriptSnapshot,
} from '@moonshot-ai/transcript';

import type { SessionTranscriptPage, SessionTranscriptQuery } from '../types';
import type { DaemonHttpClient } from './http';

export async function getSessionTranscript(
  http: DaemonHttpClient,
  sessionId: string,
  query: SessionTranscriptQuery,
): Promise<SessionTranscriptPage> {
  const raw = await http.get<unknown>(`/sessions/${encodeURIComponent(sessionId)}/transcript`, {
    agent_id: query.agentId,
    before_turn: query.beforeTurn,
    after_turn: query.afterTurn,
    page_size: query.pageSize,
  });
  const parsed = transcriptResponseSchema.parse(raw);
  const snapshot: AgentTranscriptSnapshot = {
    items: parsed.items,
    tasks: parsed.tasks,
    interactions: parsed.interactions,
    attachments: parsed.attachments,
    todos: parsed.todos,
    prompts: parsed.prompts,
    meta: parsed.meta,
    hasMoreOlder: parsed.has_more,
  };
  return {
    agentId: parsed.agent_id,
    ...snapshot,
    agents: parsed.agents,
    pendingInteractions: parsed.pending_interactions,
    ...(parsed.seq !== undefined ? { seq: parsed.seq } : {}),
  };
}
