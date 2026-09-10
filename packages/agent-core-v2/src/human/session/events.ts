import { z } from 'zod';

import { defineEvent } from '#/eventStore/events';

export const SESSION_LOG_BRANCH = '_session';

export const agentOpened = defineEvent({
  type: 'agent.opened',
  schema: z.object({ agentId: z.string(), branch: z.string() }),
});
export type AgentOpened = ReturnType<typeof agentOpened>;

export const agentClosed = defineEvent({
  type: 'agent.closed',
  schema: z.object({ agentId: z.string() }),
});
export type AgentClosed = ReturnType<typeof agentClosed>;

export const agentSwitched = defineEvent({
  type: 'agent.switched',
  schema: z.object({ agentId: z.string(), branch: z.string(), reason: z.string().optional() }),
});
export type AgentSwitched = ReturnType<typeof agentSwitched>;

export const sessionMetaUpdated = defineEvent({
  type: 'session.meta_updated',
  schema: z.object({ meta: z.unknown() }),
});
export type SessionMetaUpdated = ReturnType<typeof sessionMetaUpdated>;
