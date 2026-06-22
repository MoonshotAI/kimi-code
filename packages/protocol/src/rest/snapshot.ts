/**
 * `GET /v1/sessions/{session_id}/snapshot` — IM-style "initial sync".
 *
 * Returns an atomic-at-a-watermark view of everything a client needs to
 * rebuild a session's UI state, so the standard multi-device rebuild flow is:
 *
 *   1. `GET /sessions/{sid}/snapshot`            → state + `as_of_seq` + `epoch`
 *   2. WS `subscribe` with `cursors[sid] = { seq: as_of_seq, epoch }`
 *   3. apply live durable events (`seq > as_of_seq`) on top
 *
 * No gap and no duplication by construction: the watermark ties the REST
 * snapshot to the WS event stream.
 *
 * `in_flight_turn` carries the accumulated state of a currently-running turn
 * (volatile deltas are not replayable; this is how a reconnecting client
 * recovers mid-turn assistant/thinking text and running tool calls).
 *
 * The server reads the watermark, assembles the snapshot, then re-reads the
 * watermark and retries assembly if a durable event landed in between
 * (bounded retries). Durable events are low-frequency (turn/tool boundaries,
 * not deltas), so this converges almost immediately.
 */

import { z } from 'zod';

import { approvalRequestSchema } from '../approval';
import { messageSchema } from '../message';
import { questionRequestSchema } from '../question';
import { sessionSchema } from '../session';

export const inFlightToolCallSchema = z.object({
  tool_call_id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional(),
  description: z.string().optional(),
  /** Display payload from `tool.call.started` (ToolInputDisplay). */
  display: z.unknown().optional(),
  /** Most recent `tool.progress` update, if any. */
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
  /** Assistant text accumulated from `assistant.delta` so far. */
  assistant_text: z.string(),
  /** Thinking text accumulated from `thinking.delta` so far. */
  thinking_text: z.string(),
  /** Tool calls started but without a `tool.result` yet. */
  running_tools: z.array(inFlightToolCallSchema),
  /** Daemon prompt_id of the active prompt, if the turn was started by IPromptService. */
  current_prompt_id: z.string().optional(),
});
export type InFlightTurn = z.infer<typeof inFlightTurnSchema>;

export const sessionSnapshotResponseSchema = z.object({
  /** Durable event watermark this snapshot is consistent with. */
  as_of_seq: z.number().int().nonnegative(),
  /** Journal epoch — pass back via the WS cursor for invalidation detection. */
  epoch: z.string().min(1),
  session: sessionSchema,
  /** Most recent messages (chronological ascending), bounded page. */
  messages: z.object({
    items: z.array(messageSchema),
    has_more: z.boolean(),
  }),
  in_flight_turn: inFlightTurnSchema.nullable(),
  pending_approvals: z.array(approvalRequestSchema),
  pending_questions: z.array(questionRequestSchema),
});
export type SessionSnapshotResponse = z.infer<typeof sessionSnapshotResponseSchema>;
