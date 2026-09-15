import { z } from 'zod';

import { epochMsSchema, isoDateTimeSchema } from './base';

export const agentStatusSchema = z.enum(['idle', 'running', 'compacting']);

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentFinishReasonSchema = z.enum(['interrupted', 'completed', 'failed']);

export type AgentFinishReason = z.infer<typeof agentFinishReasonSchema>;

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
  finish_reason: agentFinishReasonSchema.optional(),
});

export type AgentStateMessage = z.infer<typeof agentStateMessageSchema>;
