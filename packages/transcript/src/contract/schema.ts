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

/** Step token usage — the engine's `TokenUsage` wire shape, verbatim. */
export const stepUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
});

export const stepTimingSchema = z.object({
  llmFirstTokenLatencyMs: z.number().optional(),
  llmStreamDurationMs: z.number().optional(),
  llmRequestBuildMs: z.number().optional(),
  llmServerFirstTokenMs: z.number().optional(),
  llmServerDecodeMs: z.number().optional(),
  llmClientConsumeMs: z.number().optional(),
});

export const stepRetrySchema = z.object({
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
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

export const toolFrameProgressSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  customKind: z.string().optional(),
  customData: z.unknown().optional(),
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
  inputText: z.string().optional(),
  progress: toolFrameProgressSchema.optional(),
  taskId: taskIdSchema.optional(),
  approvalId: z.string().optional(),
  todoId: z.string().optional(),
  agentRefs: z.array(agentRefSchema).optional(),
});

export const interactionSchema = z.object({
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
  usage: stepUsageSchema.optional(),
  finishReason: z.string().optional(),
  timing: stepTimingSchema.optional(),
  retry: stepRetrySchema.optional(),
  endReason: z.string().optional(),
  endMessage: z.string().optional(),
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
  durationMs: z.number().optional(),
  error: z.string().optional(),
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
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  stateReason: z.string().optional(),
  usage: stepUsageSchema.optional(),
});

export const goalMetaSchema = z.object({
  objective: z.string(),
  status: z.enum(['active', 'paused', 'blocked', 'complete']),
  completionCriterion: z.string().optional(),
  budgetUsed: z.number().optional(),
  budgetLimit: z.number().optional(),
});

export const modesMetaSchema = z.object({
  plan: z.object({ reviewPath: z.string().optional(), version: z.number().optional() }).optional(),
  swarm: z.object({ trigger: z.string().optional() }).optional(),
});

/** `meta.merge` contract shape: a mode key set to `null` clears that badge. */
export const modesMetaMergeSchema = z.object({
  plan: z
    .object({ reviewPath: z.string().optional(), version: z.number().optional() })
    .nullable()
    .optional(),
  swarm: z.object({ trigger: z.string().optional() }).nullable().optional(),
});

/** Same shape as the wire `agentPhaseSchema`, re-declared (this package must not import the server). */
export const agentPhaseMetaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({
    kind: z.literal('running'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('streaming'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    stream: z.enum(['assistant', 'thinking', 'tool_call']),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('tool_call'),
    turnId: z.number(),
    step: z.number(),
    toolCallId: z.string(),
    name: z.string(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('retrying'),
    turnId: z.number(),
    step: z.number(),
    stepId: z.string(),
    failedAttempt: z.number(),
    nextAttempt: z.number(),
    maxAttempts: z.number(),
    delayMs: z.number(),
    errorName: z.string().optional(),
    statusCode: z.number().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('awaiting_approval'),
    turnId: z.number(),
    step: z.number().optional(),
    approval: z.unknown().optional(),
    since: z.number(),
  }),
  z.object({
    kind: z.literal('interrupted'),
    turnId: z.number(),
    step: z.number().optional(),
    reason: z.enum(['aborted', 'max_steps', 'error']),
    message: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    kind: z.literal('ended'),
    turnId: z.number(),
    reason: z.enum(['completed', 'cancelled', 'failed', 'blocked']),
    durationMs: z.number().optional(),
    at: z.number(),
  }),
]);

export const agentUsageMetaSchema = z.object({
  byModel: z.record(z.string(), stepUsageSchema).optional(),
  currentTurn: stepUsageSchema.optional(),
  total: stepUsageSchema.optional(),
});

export const agentStatusMetaSchema = z.object({
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  usage: agentUsageMetaSchema.optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  permission: z.enum(['manual', 'yolo', 'auto']).optional(),
  phase: agentPhaseMetaSchema.optional(),
});

export const transcriptMetaSchema = z.object({
  goal: goalMetaSchema.optional(),
  modes: modesMetaSchema.optional(),
  activity: z.enum(['idle', 'turn', 'disposing', 'unknown']).optional(),
  agent: agentStatusMetaSchema.optional(),
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

export const transcriptPromptSchema = z.object({
  promptId: z.string(),
  status: z.enum(['running', 'queued', 'blocked', 'completed', 'failed', 'aborted']),
  userMessageId: z.string().optional(),
  content: z.unknown().optional(),
  createdAt: z.string(),
  finishedAt: z.string().optional(),
  steeredAt: z.string().optional(),
});

export const agentTranscriptSnapshotSchema = z.object({
  items: z.array(transcriptItemSchema),
  tasks: z.array(transcriptTaskSchema),
  // Added later; defaulted so newer consumers tolerate older servers.
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  prompts: z.array(transcriptPromptSchema).default([]),
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
  z.object({ op: z.literal('prompt.upsert'), prompt: transcriptPromptSchema }),
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
 * Transcript op-batch sequence number. Semantics (the protocol contract all
 * peers implement against):
 *
 *  - Scope: per (session, agent). Starts at 1; the server increments it once
 *    per DISPATCHED OP BATCH (not per op), so batch seqs are consecutive.
 *  - Watermark: a `seq` on `transcript.reset` or on the REST transcript
 *    response means "this state includes every batch with seq <= N".
 *  - Catch-up: a client holding watermark N asks for batches with seq > N
 *    (`GET .../transcript/ops?since_seq=N`, or the `transcript_since`
 *    subscription cursor). A `complete: false` catch-up response means the
 *    server's journal no longer reaches back to N — the client MUST fall
 *    back to a full REST refresh.
 *  - Legacy: seq is optional on every shape. A peer that omits it speaks the
 *    pre-seq protocol; consumers fall back to loss-signal-driven refreshes.
 */
export const transcriptSeqSchema = z.number().int().nonnegative();

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

/**
 * Optional sibling of `transcript` in the `client_hello` / `subscribe`
 * payloads: `Record<sessionId, Record<agentId|'*', seq>>` — the caller's
 * last applied op-batch seq per agent. When present and the server's journal
 * still covers it, the server replays the missing batches instead of sending
 * a baseline `transcript.reset`; otherwise it falls back to the reset.
 */
export const transcriptSinceSchema = z.record(
  z.string(),
  z.record(z.string(), transcriptSeqSchema),
);

// ---------------------------------------------------------------- REST

/**
 * `GET /v1/sessions/{session_id}/transcript` contract shape, owned by this
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
  prompts: z.array(transcriptPromptSchema).default([]),
  meta: transcriptMetaSchema,
  agents: z.array(agentDescriptorSchema),
  pending_interactions: z.array(z.string()),
  /** Op-batch watermark: this state includes every batch with seq <= N. */
  seq: transcriptSeqSchema.optional(),
});

/**
 * `GET /v1/sessions/{session_id}/transcript/ops` response: journaled op
 * batches with seq > `since_seq`, oldest first. `complete: false` means the
 * journal does not reach back to `since_seq` (or the session is not live) —
 * the caller must fall back to a full transcript refresh.
 */
export const transcriptOpsCatchupResponseSchema = z.object({
  agent_id: agentIdSchema,
  batches: z.array(
    z.object({ seq: transcriptSeqSchema, ops: z.array(transcriptOperationSchema) }),
  ),
  latest_seq: transcriptSeqSchema,
  complete: z.boolean(),
});

/**
 * One turn-opening input, projected out of a transcript for the
 * user-messages read: every turn whose `prompt` is defined (real user text,
 * user-slash skill/plugin commands, cron prompts, …). `origin` stays on the
 * entry so the caller can tell those kinds apart.
 */
export const transcriptUserMessageSchema = z.object({
  turn_id: turnIdSchema,
  ordinal: z.number().int(),
  state: turnStateSchema,
  origin: turnOriginSchema,
  prompt: z.string(),
  attachment_ids: z.array(z.string()).optional(),
  started_at: z.string().optional(),
});

/**
 * `GET /v1/sessions/{session_id}/transcript/user-messages` contract shape:
 * per-agent user messages (agents are separate transcripts — user input is
 * each agent's own). `agent_id` optional on the query: present reads one
 * agent, absent reads every rostered agent. `attachments` carries the
 * entities referenced by the listed messages (metadata only, never bytes).
 */
export const transcriptUserMessagesResponseSchema = z.object({
  agents: z.array(
    z.object({
      agent_id: agentIdSchema,
      messages: z.array(transcriptUserMessageSchema),
      attachments: z.array(attachmentSchema).default([]),
    }),
  ),
});

// ---------------------------------------------------------------- WS payloads

export const transcriptResetPayloadSchema = z.object({
  agent_id: agentIdSchema,
  snapshot: agentTranscriptSnapshotSchema,
  has_more_older: z.boolean(),
  /** Watermark: the snapshot includes every op batch with seq <= N. */
  seq: transcriptSeqSchema.optional(),
});

export const transcriptOpsPayloadSchema = z.object({
  agent_id: agentIdSchema,
  ops: z.array(transcriptOperationSchema),
  /** This batch's sequence number (consecutive per agent; see transcriptSeqSchema). */
  seq: transcriptSeqSchema.optional(),
});
