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

/**
 * One node of the server-derived spine task tree (agent-core-v2
 * `spineTreeViewFromState`, flattened with snake_case keys).
 */
export const spineTreeNodeSchema = z.object({
  id: z.string().min(1),
  parent_id: z.string().min(1).nullable(),
  title: z.string(),
  memory: z.string(),
  token_cost: z.number(),
  status: z.enum(['active', 'closed', 'canceled']),
  error: z.string().nullable(),
});
export type SpineTreeNode = z.infer<typeof spineTreeNodeSchema>;

/**
 * Seed of the session's FULL spine task tree, derived server-side from the
 * complete (pre-window) transcript via `deriveSpineState` +
 * `spineTreeViewFromState`, so a client rebuilding from the bounded
 * `messages.items` page still sees nodes whose transitions fell outside the
 * window. `covered_through_id` is the wire id of the last message in
 * `messages.items`: the client folds only live messages arriving after it.
 * Optional on the snapshot response for cross-version tolerance: older
 * servers do not send it, and a derivation failure drops the field instead
 * of failing the snapshot.
 */
export const spineTreeViewSchema = z.object({
  covered_through_id: z.string().min(1).nullable(),
  nodes: z.array(spineTreeNodeSchema),
});
export type SpineTreeView = z.infer<typeof spineTreeViewSchema>;

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
  spine_tree: spineTreeViewSchema.optional(),
  pending_approvals: z.array(approvalRequestSchema),
  pending_questions: z.array(questionRequestSchema),
});
export type SessionSnapshotResponse = z.infer<typeof sessionSnapshotResponseSchema>;
