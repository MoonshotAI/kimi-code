import { z } from 'zod';

export const turnIdSchema = z.string().min(1);
export const stepIdSchema = z.string().min(1);
export const frameIdSchema = z.string().min(1);
export const taskIdSchema = z.string().min(1);
export const agentIdSchema = z.string().min(1);

const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function isPlainAgentId(agentId: string): boolean {
  return AGENT_ID_PATTERN.test(agentId) && agentId !== '.' && agentId !== '..';
}

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
  promptIds: z.array(z.string()).optional(),
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
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
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
  tower: z.object({}).optional(),
});

export const modesMetaMergeSchema = z.object({
  plan: z
    .object({ reviewPath: z.string().optional(), version: z.number().optional() })
    .nullable()
    .optional(),
  swarm: z.object({ trigger: z.string().optional() }).nullable().optional(),
  tower: z.object({}).nullable().optional(),
});

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
  goal: goalMetaSchema.nullable().optional(),
  modes: modesMetaMergeSchema.optional(),
});

export const attachmentSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.string(),
  name: z.string().optional(),
  size: z.number().optional(),
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('url'), url: z.string() }),
      z.object({ kind: z.literal('file'), fileId: z.string() }),
      z.object({ kind: z.literal('session_media'), fileId: z.string() }),
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

export const transcriptGradeSchema = z.enum(['off', 'turn', 'block', 'delta']);

export const transcriptSeqSchema = z.number().int().nonnegative();

export const transcriptGradeSpecSchema = z.record(z.string(), transcriptGradeSchema);

export const transcriptSubscribeV2PayloadSchema = z.object({
  session_id: z.string().min(1),
  transcript: transcriptGradeSpecSchema,
  transcript_since: z.record(z.string(), transcriptSeqSchema).optional(),
});

export type TranscriptSubscribeV2Payload = z.infer<typeof transcriptSubscribeV2PayloadSchema>;

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
  interactions: z.array(interactionSchema).default([]),
  attachments: z.array(attachmentSchema).default([]),
  todos: z.array(todoSchema).default([]),
  prompts: z.array(transcriptPromptSchema).default([]),
  meta: transcriptMetaSchema,
  agents: z.array(agentDescriptorSchema),
  pending_interactions: z.array(z.string()),
  seq: transcriptSeqSchema.optional(),
});

export const transcriptOpsCatchupResponseSchema = z.object({
  agent_id: agentIdSchema,
  batches: z.array(
    z.object({ seq: transcriptSeqSchema, ops: z.array(transcriptOperationSchema) }),
  ),
  latest_seq: transcriptSeqSchema,
  complete: z.boolean(),
});

export const transcriptUserMessageSchema = z.object({
  turn_id: turnIdSchema,
  ordinal: z.number().int(),
  state: turnStateSchema,
  origin: turnOriginSchema,
  prompt: z.string(),
  attachment_ids: z.array(z.string()).optional(),
  started_at: z.string().optional(),
});

export const transcriptUserMessagesResponseSchema = z.object({
  agents: z.array(
    z.object({
      agent_id: agentIdSchema,
      messages: z.array(transcriptUserMessageSchema),
      attachments: z.array(attachmentSchema).default([]),
    }),
  ),
});

export const transcriptPlanReviewSchema = z.object({
  state: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  selected_option: z.string().optional(),
  feedback: z.string().optional(),
});

export const transcriptPlanEntrySchema = z.object({
  tool_call_id: z.string(),
  turn_id: turnIdSchema,
  source: z.enum(['interaction', 'display', 'output']),
  plan: z.string(),
  path: z.string().optional(),
  options: z
    .array(z.object({ label: z.string(), description: z.string().optional() }))
    .optional(),
  review: transcriptPlanReviewSchema.optional(),
});

export const transcriptPlanResponseSchema = z.object({
  agent_id: agentIdSchema,
  plans: z.array(transcriptPlanEntrySchema),
});

export const transcriptResetPayloadSchema = z.object({
  agent_id: agentIdSchema,
  snapshot: agentTranscriptSnapshotSchema,
  has_more_older: z.boolean(),
  seq: transcriptSeqSchema.optional(),
});

export const transcriptOpsPayloadSchema = z.object({
  agent_id: agentIdSchema,
  ops: z.array(transcriptOperationSchema),
  seq: transcriptSeqSchema.optional(),
});
