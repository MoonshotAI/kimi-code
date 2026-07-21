/**
 * zod schemas for every value that crosses a process boundary (REST body,
 * WS payload). Structure is closed and validated; open content envelopes
 * (tool input/output/display, payloads) validate as `z.unknown()`.
 */

import { z } from 'zod';

// ------------------------------------------------------------------ ids

export const turnIdSchema = z.string().min(1);
export const stepIdSchema = z.string().min(1);
export const frameIdSchema = z.string().min(1);
export const taskIdSchema = z.string().min(1);
export const agentIdSchema = z.string().min(1);

/**
 * Filename-safe agent id shape (engine-minted ids are slugs / ulids /
 * uuids). Beyond traversal (`/`, `\`, `.` segments), anything outside this
 * set — NUL bytes, control characters, overlong segments — makes the
 * filesystem throw unhandled errors (`ERR_INVALID_ARG_VALUE`,
 * `ENAMETOOLONG`) instead of reading a `wire.jsonl`.
 */
const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Whether an agent id is a single plain name. Ids are joined into filesystem
 * paths server-side (`<sessionDir>/agents/<agentId>/`), so anything
 * path-hostile must be rejected before it can escape the agents directory
 * or crash the read.
 */
export function isPlainAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId) && agentId !== '.' && agentId !== '..';
}

// ---------------------------------------------------------------- model

export const turnOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), payload: z.unknown().optional() }),
  z.object({
    kind: z.literal('cron'),
    taskId: taskIdSchema.optional(),
    payload: z.unknown().optional(),
  }),
  z.object({ kind: z.literal('task'), taskId: taskIdSchema, payload: z.unknown().optional() }),
  z.object({ kind: z.literal('hook'), payload: z.unknown().optional() }),
  z.object({ kind: z.literal('compaction'), payload: z.unknown().optional() }),
  z.object({ kind: z.literal('side'), payload: z.unknown().optional() }),
  z.object({ kind: z.literal('other'), payload: z.unknown().optional() }),
]);

export const transcriptUsageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedTokens: z.number().optional(),
  cost: z.number().optional(),
});

export const turnStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export const stepStateSchema = z.enum(['running', 'completed', 'interrupted', 'failed']);

export const textFrameSchema = z.object({
  kind: z.literal('text'),
  frameId: frameIdSchema,
  role: z.enum(['assistant', 'user']),
  text: z.string(),
  attachmentIds: z.array(z.string()).optional(),
  taskId: taskIdSchema.optional(),
});

export const thinkingFrameSchema = z.object({
  kind: z.literal('thinking'),
  frameId: frameIdSchema,
  text: z.string(),
});

export const agentRefSchema = z.object({
  agentId: agentIdSchema,
  role: z.enum(['child', 'member']).optional(),
});

export const toolCallFrameSchema = z.object({
  kind: z.literal('tool'),
  frameId: frameIdSchema,
  toolCallId: z.string(),
  name: z.string(),
  view: z.string().optional(),
  state: z.enum(['running', 'done', 'error']),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  display: z.unknown().optional(),
  error: z.string().optional(),
  taskId: taskIdSchema.optional(),
  approvalId: z.string().optional(),
  todoId: z.string().optional(),
  agentRefs: z.array(agentRefSchema).optional(),
});

export const interactionSchema = z.object({
  interactionId: z.string(),
  interactionKind: z.enum(['approval', 'question']),
  toolCallId: z.string(),
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'answered', 'dismissed']),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
});

export const interactionFrameSchema = z.object({
  kind: z.literal('interaction'),
  frameId: frameIdSchema,
  interactionId: z.string(),
  interactionKind: z.enum(['approval', 'question']),
  toolCallId: z.string().optional(),
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'answered', 'dismissed']),
  request: z.unknown().optional(),
  response: z.unknown().optional(),
});

export const noticeFrameSchema = z.object({
  kind: z.literal('notice'),
  frameId: frameIdSchema,
  level: z.enum(['error', 'warning', 'info']),
  source: z.string().optional(),
  message: z.string(),
  detail: z.unknown().optional(),
});

export const transcriptFrameSchema = z.discriminatedUnion('kind', [
  textFrameSchema,
  thinkingFrameSchema,
  toolCallFrameSchema,
  interactionFrameSchema,
  noticeFrameSchema,
]);

export const transcriptStepSchema = z.object({
  kind: z.literal('step'),
  stepId: stepIdSchema,
  turnId: turnIdSchema,
  ordinal: z.number().int(),
  state: stepStateSchema,
  frames: z.array(transcriptFrameSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});

export const transcriptTurnSchema = z.object({
  kind: z.literal('turn'),
  turnId: turnIdSchema,
  ordinal: z.number().int(),
  state: turnStateSchema,
  origin: turnOriginSchema,
  prompt: z.string().optional(),
  attachmentIds: z.array(z.string()).optional(),
  steps: z.array(transcriptStepSchema),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  usage: transcriptUsageSchema.optional(),
});

export const transcriptMarkerSchema = z.object({
  kind: z.literal('marker'),
  markerId: z.string(),
  marker: z.string(),
  payload: z.unknown().optional(),
  at: z.string().optional(),
});

export const transcriptTaskRefSchema = z.object({
  kind: z.literal('taskref'),
  refId: z.string(),
  taskId: taskIdSchema,
  at: z.string().optional(),
});

export const transcriptItemSchema = z.discriminatedUnion('kind', [
  transcriptTurnSchema,
  transcriptMarkerSchema,
  transcriptTaskRefSchema,
]);

export const transcriptTaskSchema = z.object({
  taskId: taskIdSchema,
  kind: z.enum(['shell', 'subagent', 'tool', 'other']),
  state: z.enum(['running', 'completed', 'failed', 'timed_out', 'killed', 'lost']),
  detached: z.boolean(),
  description: z.string().optional(),
  agentId: agentIdSchema.optional(),
  outputTail: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
});

export const goalMetaSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completionCriterion: z.string().optional(),
  budgetUsed: z.number().optional(),
  budgetLimit: z.number().optional(),
});

export const modesMetaSchema = z.object({
  plan: z.object({ reviewPath: z.string().optional() }).optional(),
  swarm: z.object({ trigger: z.string().optional() }).optional(),
});

/** `meta.merge` wire shape: a mode key set to `null` clears that badge. */
export const modesMetaMergeSchema = z.object({
  plan: z.object({ reviewPath: z.string().optional() }).nullable().optional(),
  swarm: z.object({ trigger: z.string().optional() }).nullable().optional(),
});

export const transcriptMetaSchema = z.object({
  goal: goalMetaSchema.optional(),
  modes: modesMetaSchema.optional(),
  activity: z.enum(['idle', 'turn', 'disposing', 'unknown']).optional(),
});

export const transcriptMetaMergeSchema = transcriptMetaSchema.extend({
  modes: modesMetaMergeSchema.optional(),
});

// ---------------------------------------------------------------- ops

export const attachmentSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('url'), url: z.string() }),
      z.object({ kind: z.literal('file'), fileId: z.string() }),
    ])
    .optional(),
  placeholder: z.string().optional(),
});

export const todoItemSchema = z.object({
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'done']),
});

export const todoSchema = z.object({
  todoId: z.string(),
  items: z.array(todoItemSchema),
  updatedAt: z.string().optional(),
});

export const agentTranscriptSnapshotSchema = z.object({
  items: z.array(transcriptItemSchema),
  tasks: z.array(transcriptTaskSchema),
  // Added later; defaulted so newer consumers tolerate older servers.
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  meta: transcriptMetaSchema,
  hasMoreOlder: z.boolean().optional(),
});

export const turnHeaderSchema = transcriptTurnSchema.omit({ steps: true });
export const stepHeaderSchema = transcriptStepSchema.omit({ frames: true });

export const appendTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('frame'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frameId: frameIdSchema,
  }),
  z.object({ type: z.literal('task'), taskId: taskIdSchema }),
]);

export const transcriptOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('reset'), agentId: agentIdSchema, snapshot: agentTranscriptSnapshotSchema }),
  z.object({ op: z.literal('turn.upsert'), turn: turnHeaderSchema }),
  z.object({ op: z.literal('step.upsert'), turnId: turnIdSchema, step: stepHeaderSchema }),
  z.object({
    op: z.literal('frame.upsert'),
    turnId: turnIdSchema,
    stepId: stepIdSchema,
    frame: transcriptFrameSchema,
  }),
  z.object({
    op: z.literal('append'),
    target: appendTargetSchema,
    offset: z.number().int().nonnegative(),
    text: z.string(),
  }),
  z.object({
    op: z.literal('marker.upsert'),
    item: transcriptMarkerSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({
    op: z.literal('taskref.upsert'),
    item: transcriptTaskRefSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({ op: z.literal('task.upsert'), task: transcriptTaskSchema }),
  z.object({ op: z.literal('interaction.upsert'), interaction: interactionSchema }),
  z.object({ op: z.literal('attachment.upsert'), attachment: attachmentSchema }),
  z.object({ op: z.literal('todo.upsert'), todo: todoSchema }),
  z.object({ op: z.literal('meta.merge'), meta: transcriptMetaMergeSchema }),
  z.object({ op: z.literal('items.remove'), ids: z.array(z.string()) }),
]);

export const transcriptOpBatchSchema = z.object({
  agentId: agentIdSchema,
  ops: z.array(transcriptOperationSchema),
});

// ---------------------------------------------------------------- subscription

export const transcriptGradeSchema = z.enum(['off', 'turn', 'block', 'delta']);

/**
 * Per-session grade map: `'*'` is the default, explicit agent ids override.
 * Record<agentId|'*', grade>.
 */
export const transcriptGradeSpecSchema = z.record(z.string(), transcriptGradeSchema);

/**
 * Per-session transcript subscriptions, carried as the `transcript` field of
 * the v1 WS `client_hello` / `subscribe` control payloads:
 * `Record<sessionId, TranscriptGradeSpec>`. This contract is owned by THIS
 * package (transcript types never live in `@moonshot-ai/protocol`); the v1
 * connection layer passes the raw field through and validates it with this
 * schema, so legacy servers/clients ignore it safely (absent = all off).
 */
export const transcriptSubscriptionSchema = z.record(z.string(), transcriptGradeSpecSchema);

// ---------------------------------------------------------------- REST

/**
 * `GET /v1/sessions/{session_id}/transcript` wire shape, owned by this
 * package: `agent_id` (required) + turn cursor (`before_turn` / `after_turn`,
 * mutually exclusive) + `page_size` (default 20, max 100). The page unit is
 * the turn (contiguous turn slice plus segment markers/taskrefs); `tasks`,
 * `interactions`, `meta`, `agents` and `pending_interactions` are global
 * state and ship unpaginated with every response.
 */
export const transcriptQuerySchema = z
  .object({
    agent_id: agentIdSchema,
    before_turn: z.string().min(1).optional(),
    after_turn: z.string().min(1).optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.before_turn !== undefined && value.after_turn !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'before_turn and after_turn are mutually exclusive',
        path: ['before_turn'],
      });
    }
    if (!isPlainAgentId(value.agent_id)) {
      ctx.addIssue({
        code: 'custom',
        message: 'agent_id must be a plain agent id (no path separators)',
        path: ['agent_id'],
      });
    }
  });

export const agentDescriptorSchema = z.object({
  agentId: agentIdSchema,
  type: z.enum(['main', 'sub', 'independent']).optional(),
  parentAgentId: agentIdSchema.optional(),
  label: z.string().optional(),
  createdAt: z.string().optional(),
  disposedAt: z.string().optional(),
});

export const transcriptResponseSchema = z.object({
  agent_id: agentIdSchema,
  items: z.array(transcriptItemSchema),
  has_more: z.boolean(),
  tasks: z.array(transcriptTaskSchema),
  // Added later; defaulted so newer consumers tolerate older servers.
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  meta: transcriptMetaSchema,
  agents: z.array(agentDescriptorSchema),
  pending_interactions: z.array(z.string()),
});

// ---------------------------------------------------------------- WS payloads

export const transcriptResetPayloadSchema = z.object({
  agent_id: agentIdSchema,
  snapshot: agentTranscriptSnapshotSchema,
  has_more_older: z.boolean(),
});

export const transcriptOpsPayloadSchema = z.object({
  agent_id: agentIdSchema,
  ops: z.array(transcriptOperationSchema),
});
