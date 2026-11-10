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
  schema: z.object({
    agentId: z.string(),
    branch: z.string(),
    reason: z.string().optional(),
    stats: z.record(z.string(), z.number()).optional(),
  }),
});
export type AgentSwitched = ReturnType<typeof agentSwitched>;

export const sessionMetaUpdated = defineEvent({
  type: 'session.meta_updated',
  schema: z.object({ meta: z.unknown() }),
});
export type SessionMetaUpdated = ReturnType<typeof sessionMetaUpdated>;

export const compactionStarted = defineEvent({
  type: 'compaction.started',
  schema: z.object({
    agentId: z.string(),
    reason: z.string(),
    instruction: z.string().optional(),
  }),
});
export type CompactionStarted = ReturnType<typeof compactionStarted>;

export const compactionCompleted = defineEvent({
  type: 'compaction.completed',
  schema: z.object({ agentId: z.string(), branch: z.string() }),
});
export type CompactionCompleted = ReturnType<typeof compactionCompleted>;

export const compactionCancelled = defineEvent({
  type: 'compaction.cancelled',
  schema: z.object({
    agentId: z.string(),
    cause: z.string(),
    errorMessage: z.string().optional(),
  }),
});
export type CompactionCancelled = ReturnType<typeof compactionCancelled>;
