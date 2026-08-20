import { z } from 'zod';

import { messageSchema } from './message';

import { approvalRequestSchema } from './approval';
import { questionRequestSchema } from './question';
import { sessionSchema } from './session';
import { taskSchema } from './task';

export const inFlightToolCallSchema = z.object({
  tool_call_id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
  description: z.string().optional(),
  display: z.unknown().optional(),
  last_progress: z
    .object({
      kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
      text: z.string().optional(),
      percent: z.number().optional(),
    })
    .optional(),
});
export type InFlightToolCall = z.infer<typeof inFlightToolCallSchema>;

export const inFlightTurnSchema = z.object({
  turn_id: z.number().int().nonnegative(),
  assistant_text: z.string(),
  thinking_text: z.string(),
  running_tools: z.array(inFlightToolCallSchema),
  current_prompt_id: z.string().optional(),
});
export type InFlightTurn = z.infer<typeof inFlightTurnSchema>;

/**
 * A live subagent task as of the snapshot watermark. Extends the base task
 * wire shape with the swarm identity metadata that otherwise only rides the
 * (non-replayed) `subagent.spawned` WS event.
 */
export const snapshotSubagentSchema = taskSchema.extend({
  subagent_phase: z.enum(['queued', 'working', 'suspended', 'completed', 'failed']).optional(),
  subagent_type: z.string().optional(),
  parent_tool_call_id: z.string().optional(),
  suspended_reason: z.string().optional(),
  swarm_index: z.number().int().nonnegative().optional(),
  run_in_background: z.boolean().optional(),
});
export type SnapshotSubagent = z.infer<typeof snapshotSubagentSchema>;

export const sessionSnapshotResponseSchema = z.object({
  as_of_seq: z.number().int().nonnegative(),
  epoch: z.string().min(1),
  session: sessionSchema,
  messages: z.object({
    items: z.array(messageSchema),
    has_more: z.boolean(),
  }),
  in_flight_turn: inFlightTurnSchema.nullable(),
  subagents: z.array(snapshotSubagentSchema).optional(),
  pending_approvals: z.array(approvalRequestSchema),
  pending_questions: z.array(questionRequestSchema),
});
export type SessionSnapshotResponse = z.infer<typeof sessionSnapshotResponseSchema>;
