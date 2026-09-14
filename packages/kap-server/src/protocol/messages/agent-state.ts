import { z } from 'zod';

import { epochMsSchema, isoDateTimeSchema } from './base';

export const agentStatusSchema = z.enum(['idle', 'running', 'interrupted', 'completed', 'failed']);

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentStateOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('btw') }),
  z.object({ kind: z.literal('main') }),
  z.object({
    kind: z.literal('tool-swarm'),
    tool_call_id: z.string().min(1),
    swarm_index: z.number().int().nonnegative(),
    parent_agent_id: z.string().min(1),
  }),
  z.object({
    kind: z.literal('tool-agent'),
    tool_call_id: z.string().min(1),
    parent_agent_id: z.string().min(1),
  }),
]);

export type AgentStateOrigin = z.infer<typeof agentStateOriginSchema>;

export const agentStateTurnSchema = z.object({
  status: z.enum(['thinking', 'retrying', 'acting', 'aborting']),
});

export type AgentStateTurn = z.infer<typeof agentStateTurnSchema>;

export const agentStateMessageSchema = z.object({
  type: z.literal('agent.state'),
  session_id: z.string().min(1),
  agent_id: z.string().min(1),
  profile: z.object({ kind: z.string() }),
  timestamp: epochMsSchema,
  origin: agentStateOriginSchema,
  created_at: isoDateTimeSchema,
  ended_at: isoDateTimeSchema.optional(),
  status: agentStatusSchema,
  turn: agentStateTurnSchema.optional(),
});

export type AgentStateMessage = z.infer<typeof agentStateMessageSchema>;
