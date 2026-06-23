import type { ResumedAgentState } from '@moonshot-ai/agent-core';
import type { Message as ProtocolMessage, Session as ProtocolSession, SessionSnapshotResponse } from '@moonshot-ai/protocol';

import { toContextMessage, toSessionSummary } from '../mappers';
import type { CoreApiHandlerMap } from '../types';

interface ResumePayload {
  readonly sessionId: string;
}

export const resumeHandlers: CoreApiHandlerMap = {
  resumeSession: async (payload, ctx) => {
    const { sessionId } = payload as ResumePayload;
    const snapshot = await ctx.http.get<SessionSnapshotResponse>(`/sessions/${sessionId}/snapshot`);
    const summary = toSessionSummary(snapshot.session);

    const messages = snapshot.messages.items.map(toContextMessage);
    const replay: ResumedAgentState['replay'] = messages.map((message) => ({
      type: 'message',
      time: Date.parse(snapshot.session.updated_at),
      message,
    }));

    const agents: Record<string, ResumedAgentState> = {
      main: {
        type: 'main',
        config: {},
        context: { history: messages, tokenCount: snapshot.session.usage.context_tokens },
        replay,
        permission: { mode: snapshot.session.agent_config.permission_mode ?? 'manual' },
        plan: null,
        usage: {},
        tools: [],
        background: [],
      } as unknown as ResumedAgentState,
    };

    return {
      ...summary,
      sessionMetadata: { agents: {} },
      agents,
      warning: undefined,
    };
  },
};
