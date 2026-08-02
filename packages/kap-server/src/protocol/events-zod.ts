import { isoDateTimeSchema } from './session';
import { messageContentSchema } from './message';
/**
 * Zod schema half of the v1 event catalog (`packages/protocol/src/events.ts`),
 * ported verbatim for byte-level AsyncAPI/JSON-Schema compatibility. Interface
 * declarations and the deprecated volatile-event helpers are intentionally not
 * ported. Stage 4 (protocol localisation): the `satisfies z.ZodType<T>`
 * clauses were dropped along with their agent-core-v2 type-only imports —
 * they were type assertions only and do not affect the emitted JSON Schema.
 */
import { z } from 'zod';

import { ToolInputDisplaySchema } from './display';
import { configResponseSchema } from './rest-config';
import { sessionPendingInteractionSchema, sessionSchema } from './session';
import { workspaceSchema } from './workspace';

export const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
})

export const finishReasonSchema = z.enum([
  'completed',
  'tool_calls',
  'truncated',
  'filtered',
  'paused',
  'other',
])

export const usageStatusSchema = z.object({
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  currentTurn: tokenUsageSchema.optional(),
  total: tokenUsageSchema.optional(),
})

export const permissionModeSchema = z.enum([
  'manual',
  'yolo',
  'auto',
])

export const skillSourceSchema = z.enum([
  'project',
  'user',
  'extra',
  'builtin',
])

export const userPromptOriginSchema = z.object({
  kind: z.literal('user'),
})

export const skillActivationOriginSchema = z.object({
  kind: z.literal('skill_activation'),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
  skillType: z.string().optional(),
  skillPath: z.string().optional(),
  skillSource: skillSourceSchema.optional(),
})

export const pluginCommandOriginSchema = z.object({
  kind: z.literal('plugin_command'),
  activationId: z.string(),
  pluginId: z.string(),
  commandName: z.string(),
  commandArgs: z.string().optional(),
  trigger: z.literal('user-slash'),
})

export const injectionOriginSchema = z.object({
  kind: z.literal('injection'),
  variant: z.string(),
})

export const shellCommandOriginSchema = z.object({
  kind: z.literal('shell_command'),
  phase: z.enum(['input', 'output']),
  isError: z.boolean().optional(),
})

export const compactionSummaryOriginSchema = z.object({
  kind: z.literal('compaction_summary'),
})

export const systemTriggerOriginSchema = z.object({
  kind: z.literal('system_trigger'),
  name: z.string(),
})

export const taskLifecycleStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
])

export const taskOriginSchema = z.object({
  kind: z.literal('task'),
  taskId: z.string(),
  status: taskLifecycleStatusSchema,
  notificationId: z.string(),
})

export const backgroundTaskOriginSchema = z.object({
  kind: z.literal('background_task'),
  taskId: z.string(),
  status: taskLifecycleStatusSchema,
  notificationId: z.string(),
});

export const cronJobOriginSchema = z.object({
  kind: z.literal('cron_job'),
  jobId: z.string(),
  cron: z.string(),
  recurring: z.boolean(),
  coalescedCount: z.number(),
  stale: z.boolean(),
})

export const cronMissedOriginSchema = z.object({
  kind: z.literal('cron_missed'),
  count: z.number(),
})

export const hookResultOriginSchema = z.object({
  kind: z.literal('hook_result'),
  event: z.string(),
  blocked: z.boolean().optional(),
})

export const retryOriginSchema = z.object({
  kind: z.literal('retry'),
  trigger: z.string().optional(),
})

export const promptOriginSchema = z.discriminatedUnion('kind', [
  userPromptOriginSchema,
  skillActivationOriginSchema,
  pluginCommandOriginSchema,
  injectionOriginSchema,
  shellCommandOriginSchema,
  compactionSummaryOriginSchema,
  systemTriggerOriginSchema,
  taskOriginSchema,
  backgroundTaskOriginSchema,
  cronJobOriginSchema,
  cronMissedOriginSchema,
  hookResultOriginSchema,
  retryOriginSchema,
]);

export const goalStatusSchema = z.enum([
  'active',
  'paused',
  'blocked',
  'complete',
  'budget_limited',
  'usage_limited',
])

export const goalActorSchema = z.enum([
  'user',
  'model',
  'runtime',
  'system',
])

export const goalBudgetLimitsSchema = z.object({
  tokenBudget: z.number().optional(),
  turnBudget: z.number().optional(),
  wallClockBudgetMs: z.number().optional(),
})

export const goalBudgetReportSchema = z.object({
  tokenBudget: z.number().nullable(),
  turnBudget: z.number().nullable(),
  wallClockBudgetMs: z.number().nullable(),
  remainingTokens: z.number().nullable(),
  remainingTurns: z.number().nullable(),
  remainingWallClockMs: z.number().nullable(),
  tokenBudgetReached: z.boolean(),
  turnBudgetReached: z.boolean(),
  wallClockBudgetReached: z.boolean(),
  overBudget: z.boolean(),
  inputTokensUsed: z.number(),
  outputTokensUsed: z.number(),
})

export const goalSnapshotSchema = z.object({
  goalId: z.string(),
  objective: z.string(),
  completionCriterion: z.string().optional(),
  status: goalStatusSchema,
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  inputTokensUsed: z.number(),
  outputTokensUsed: z.number(),
  wallClockMs: z.number(),
  budget: goalBudgetReportSchema,
  terminalReason: z.string().optional(),
  blockedStreak: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export const goalToolResultSchema = z.object({
  goal: goalSnapshotSchema.nullable(),
})

export const goalChangeStatsSchema = z.object({
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  wallClockMs: z.number(),
})

export const goalChangeKindSchema = z.enum([
  'lifecycle',
  'completion',
])

export const goalChangeSchema = z.object({
  kind: goalChangeKindSchema,
  status: goalStatusSchema.optional(),
  reason: z.string().optional(),
  stats: goalChangeStatsSchema.optional(),
  actor: goalActorSchema.optional(),
})

export const kimiErrorCodeSchema = z.enum([
  'config.invalid',
  'session.not_found',
  'session.already_exists',
  'session.id_invalid',
  'session.id_required',
  'session.id_empty',
  'session.title_empty',
  'session.state_not_found',
  'session.state_invalid',
  'session.fork_active_turn',
  'session.undo_unavailable',
  'session.export_not_found',
  'session.export_missing_version',
  'session.export_output_conflict',
  'session.export_too_large',
  'session.closed',
  'session.permission_mode_invalid',
  'session.thinking_empty',
  'session.model_empty',
  'session.plan_mode_invalid',
  'session.approval_handler_error',
  'session.question_handler_error',
  'session.init_failed',
  'agent.not_found',
  'activity.agent_busy',
  'activity.cancelling',
  'activity.disposing',
  'activity.disposed',
  'activity.initializing',
  'activity.session_rejected',
  'turn.agent_busy',
  'goal.already_exists',
  'goal.not_found',
  'goal.objective_empty',
  'goal.objective_too_long',
  'goal.status_invalid',
  'goal.metadata_reserved',
  'goal.not_resumable',
  'goal.unsupported_agent',
  'model.not_configured',
  'model.config_invalid',
  'profile.thinking_alias_conflict',
  'model.not_found',
  'auth.login_required',
  'auth.provisioning_required',
  'auth.token_missing',
  'auth.token_unauthorized',
  'auth.model_not_resolved',
  'context.overflow',
  'loop.max_steps_exceeded',
  'provider.api_error',
  'provider.filtered',
  'provider.rate_limit',
  'provider.auth_error',
  'provider.connection_error',
  'provider.overloaded',
  'provider.not_found',
  'skill.not_found',
  'skill.type_unsupported',
  'skill.name_empty',
  'records.write_failed',
  'compaction.failed',
  'compaction.unable',
  'task.task_id_empty',
  'usage.turn_id_conflict',
  'mcp.server_not_found',
  'mcp.server_disabled',
  'mcp.startup_failed',
  'mcp.tool_name_collision',
  'message.not_found',
  'plugin.not_found',
  'plugin.load_failed',
  'request.invalid',
  'request.work_dir_required',
  'request.prompt_input_empty',
  'prompt.not_found',
  'prompt.already_completed',
  'session.busy',
  'shell.git_bash_not_found',
  'workspace.not_found',
  'terminal.not_found',
  'file.not_found',
  'file.too_large',
  'fs.path_not_found',
  'fs.permission_denied',
  'fs.path_escapes',
  'fs.is_directory',
  'fs.is_binary',
  'fs.too_large',
  'fs.already_exists',
  'fs.too_many_results',
  'fs.grep_timeout',
  'fs.git_unavailable',
  'validation.failed',
  'not_implemented',
  'internal',
]);

export const kimiErrorPayloadSchema: z.ZodType = z.lazy(
  () => kimiErrorPayloadObjectSchema,
);

const kimiErrorPayloadObjectSchema = z.object({
  code: kimiErrorCodeSchema,
  message: z.string(),
  name: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
  cause: kimiErrorPayloadSchema.optional(),
});

export const taskInfoBaseSchema = z.object({
  taskId: z.string(),
  description: z.string(),
  status: taskLifecycleStatusSchema,
  detached: z.boolean().optional(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  stopReason: z.string().optional(),
  terminalNotificationSuppressed: z.boolean().optional(),
  timeoutMs: z.number().optional(),
});

export const processTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('process'),
  command: z.string(),
  pid: z.number(),
  exitCode: z.number().nullable(),
});

export const agentTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('agent'),
  agentId: z.string().optional(),
  subagentType: z.string().optional(),
});

export const questionTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('question'),
  questionCount: z.number(),
  toolCallId: z.string().optional(),
});

export const taskInfoSchema = z.discriminatedUnion('kind', [
  processTaskInfoSchema,
  agentTaskInfoSchema,
  questionTaskInfoSchema,
]);

export const compactionResultSchema = z.object({
  summary: z.string(),
  compactedCount: z.number(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
  keptUserMessageCount: z.number().optional(),
  keptHeadUserMessageCount: z.number().optional(),
  droppedCount: z.number().optional(),
})

export const toolUpdateSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  customKind: z.string().optional(),
  customData: z.unknown().optional(),
})

export const mcpOAuthAuthorizationUrlUpdateDataSchema = z.object({
  serverName: z.string(),
  authorizationUrl: z.string(),
})

export const turnEndReasonSchema = z.enum([
  'completed',
  'cancelled',
  'failed',
  'blocked',
])

export const agentPhaseSchema = z.discriminatedUnion('kind', [
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
    reason: turnEndReasonSchema,
    durationMs: z.number().optional(),
    at: z.number(),
  }),
]);

export const agentStatusUpdatedEventSchema = z.object({
  type: z.literal('agent.status.updated'),
  model: z.string().optional(),
  thinkingEffort: z.string().optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  planMode: z.boolean().optional(),
  swarmMode: z.boolean().optional(),
  permission: permissionModeSchema.optional(),
  usage: usageStatusSchema.optional(),
  phase: agentPhaseSchema.optional(),
});

export const sessionMetaUpdatedEventSchema = z.object({
  type: z.literal('session.meta.updated'),
  title: z.string().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
});

export const agentCreatedEventSchema = z.object({
  type: z.literal('agent.created'),
});

export const agentDisposedEventSchema = z.object({
  type: z.literal('agent.disposed'),
});

export const sessionCreatedEventSchema = z.object({
  type: z.literal('event.session.created'),
  session: sessionSchema,
});

export const workspaceCreatedEventSchema = z.object({
  type: z.literal('event.workspace.created'),
  workspace: workspaceSchema,
});

export const workspaceUpdatedEventSchema = z.object({
  type: z.literal('event.workspace.updated'),
  workspace: workspaceSchema,
});

export const workspaceDeletedEventSchema = z.object({
  type: z.literal('event.workspace.deleted'),
  workspace_id: z.string().min(1),
  root: z.string().min(1),
});

export const sessionWorkChangedEventSchema = z.object({
  type: z.literal('event.session.work_changed'),
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
});

const legacySessionStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_approval',
  'awaiting_question',
  'aborted',
]);

export const sessionStatusChangedEventSchema = z.object({
  type: z.literal('event.session.status_changed'),
  status: legacySessionStatusSchema,
  previous_status: legacySessionStatusSchema,
  current_prompt_id: z.string().min(1).optional(),
});

export const configChangedEventSchema = z.object({
  type: z.literal('event.config.changed'),
  changedFields: z.array(z.string()),
  config: configResponseSchema,
});

export const goalUpdatedEventSchema = z.object({
  type: z.literal('goal.updated'),
  snapshot: goalSnapshotSchema.nullable(),
  change: goalChangeSchema.optional(),
});

export const skillActivatedEventSchema = z.object({
  type: z.literal('skill.activated'),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
  skillPath: z.string().optional(),
  skillSource: skillSourceSchema.optional(),
});

export const pluginCommandActivatedEventSchema = z.object({
  type: z.literal('plugin_command.activated'),
  activationId: z.string(),
  pluginId: z.string(),
  commandName: z.string(),
  commandArgs: z.string().optional(),
  trigger: z.literal('user-slash'),
})

export const errorEventSchema = kimiErrorPayloadObjectSchema.extend({
  type: z.literal('error'),
});

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  message: z.string(),
  code: z.string().optional(),
})

export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  turnId: z.number(),
  origin: promptOriginSchema,
  prompt: z.string().optional(),
});

export const turnEndedEventSchema = z.object({
  type: z.literal('turn.ended'),
  turnId: z.number(),
  reason: turnEndReasonSchema,
  error: kimiErrorPayloadSchema.optional(),
  durationMs: z.number().optional(),
});

export const turnStepStartedEventSchema = z.object({
  type: z.literal('turn.step.started'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
})

export const turnStepCompletedEventSchema = z.object({
  type: z.literal('turn.step.completed'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  usage: tokenUsageSchema.optional(),
  finishReason: z.string().optional(),
  llmFirstTokenLatencyMs: z.number().optional(),
  llmStreamDurationMs: z.number().optional(),
  llmRequestBuildMs: z.number().optional(),
  llmServerFirstTokenMs: z.number().optional(),
  llmServerDecodeMs: z.number().optional(),
  llmClientConsumeMs: z.number().optional(),
  providerFinishReason: finishReasonSchema.optional(),
  rawFinishReason: z.string().optional(),
})

export const turnStepRetryingEventSchema = z.object({
  type: z.literal('turn.step.retrying'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
})

export const turnStepInterruptedEventSchema = z.object({
  type: z.literal('turn.step.interrupted'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  reason: z.string(),
  message: z.string().optional(),
})

export const assistantDeltaEventSchema = z.object({
  type: z.literal('assistant.delta'),
  turnId: z.number(),
  delta: z.string(),
})

export const hookResultEventSchema = z.object({
  type: z.literal('hook.result'),
  turnId: z.number().optional(),
  hookEvent: z.string(),
  content: z.string(),
  blocked: z.boolean().optional(),
})

export const thinkingDeltaEventSchema = z.object({
  type: z.literal('thinking.delta'),
  turnId: z.number(),
  delta: z.string(),
})

export const toolCallDeltaEventSchema = z.object({
  type: z.literal('tool.call.delta'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string().optional(),
  argumentsPart: z.string().optional(),
})

export const toolCallStartedEventSchema = z.object({
  type: z.literal('tool.call.started'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  description: z.string().optional(),
  display: ToolInputDisplaySchema.optional(),
})

export const toolProgressEventSchema = z.object({
  type: z.literal('tool.progress'),
  turnId: z.number(),
  toolCallId: z.string(),
  update: toolUpdateSchema,
})

export const shellOutputEventSchema = z.object({
  type: z.literal('shell.output'),
  commandId: z.string(),
  update: toolUpdateSchema,
  taskId: z.string().optional(),
})

export const shellStartedEventSchema = z.object({
  type: z.literal('shell.started'),
  commandId: z.string(),
  taskId: z.string(),
})

export const shellCompletedEventSchema = z.object({
  type: z.literal('shell.completed'),
  commandId: z.string(),
  isError: z.boolean(),
  taskId: z.string().optional(),
})

export const toolResultEventSchema = z.object({
  type: z.literal('tool.result'),
  turnId: z.number(),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  synthetic: z.boolean().optional(),
})

export const subagentSpawnedEventSchema = z.object({
  type: z.literal('subagent.spawned'),
  subagentId: z.string(),
  subagentName: z.string(),
  parentToolCallId: z.string(),
  parentToolCallUuid: z.string().optional(),
  parentAgentId: z.string().optional(),
  callerAgentId: z.string().optional(),
  description: z.string().optional(),
  swarmIndex: z.number().optional(),
  runInBackground: z.boolean(),
})

export const subagentStartedEventSchema = z.object({
  type: z.literal('subagent.started'),
  subagentId: z.string(),
})

export const subagentSuspendedEventSchema = z.object({
  type: z.literal('subagent.suspended'),
  subagentId: z.string(),
  reason: z.string(),
})

export const subagentCompletedEventSchema = z.object({
  type: z.literal('subagent.completed'),
  subagentId: z.string(),
  resultSummary: z.string(),
  usage: tokenUsageSchema.optional(),
  contextTokens: z.number().optional(),
})

export const subagentFailedEventSchema = z.object({
  type: z.literal('subagent.failed'),
  subagentId: z.string(),
  error: z.string(),
})

export const compactionStartedEventSchema = z.object({
  type: z.literal('compaction.started'),
  trigger: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
})

export const compactionBlockedEventSchema = z.object({
  type: z.literal('compaction.blocked'),
  turnId: z.number().optional(),
})

export const compactionCancelledEventSchema = z.object({
  type: z.literal('compaction.cancelled'),
})

export const compactionCompletedEventSchema = z.object({
  type: z.literal('compaction.completed'),
  result: compactionResultSchema,
})

export const taskStartedEventSchema = z.object({
  type: z.literal('task.started'),
  info: taskInfoSchema,
});

export const taskTerminatedEventSchema = z.object({
  type: z.literal('task.terminated'),
  info: taskInfoSchema,
});

export const backgroundTaskStartedEventSchema = z.object({
  type: z.literal('background.task.started'),
  info: taskInfoSchema,
});

export const backgroundTaskTerminatedEventSchema = z.object({
  type: z.literal('background.task.terminated'),
  info: taskInfoSchema,
});

export const cronFiredEventSchema = z.object({
  type: z.literal('cron.fired'),
  origin: cronJobOriginSchema,
  prompt: z.string(),
});

export const promptSubmittedEventSchema = z.object({
  type: z.literal('prompt.submitted'),
  promptId: z.string(),
  userMessageId: z.string(),
  status: z.enum(['running', 'queued', 'blocked']),
  content: z.array(messageContentSchema),
  createdAt: isoDateTimeSchema,
});

export const promptCompletedEventSchema = z.object({
  type: z.literal('prompt.completed'),
  promptId: z.string(),
  finishedAt: isoDateTimeSchema,
  reason: z.enum(['completed', 'failed', 'blocked']).optional(),
});

export const promptAbortedEventSchema = z.object({
  type: z.literal('prompt.aborted'),
  promptId: z.string(),
  abortedAt: isoDateTimeSchema,
});

export const promptSteeredEventSchema = z.object({
  type: z.literal('prompt.steered'),
  activePromptId: z.string(),
  promptIds: z.array(z.string()),
  content: z.array(messageContentSchema),
  steeredAt: isoDateTimeSchema,
});

export const toolListUpdatedReasonSchema = z.enum([
  'mcp.connected',
  'mcp.disconnected',
  'mcp.failed',
])

export const toolListUpdatedEventSchema = z.object({
  type: z.literal('tool.list.updated'),
  reason: toolListUpdatedReasonSchema,
  serverName: z.string(),
})

export const mcpServerStatusPayloadSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth']),
  toolCount: z.number(),
  error: z.string().optional(),
})

export const mcpServerStatusEventSchema = z.object({
  type: z.literal('mcp.server.status'),
  server: mcpServerStatusPayloadSchema,
})

export const agentEventSchema = z.discriminatedUnion('type', [
  errorEventSchema,
  warningEventSchema,
  agentStatusUpdatedEventSchema,
  agentCreatedEventSchema,
  agentDisposedEventSchema,
  sessionMetaUpdatedEventSchema,
  sessionCreatedEventSchema,
  workspaceCreatedEventSchema,
  workspaceUpdatedEventSchema,
  workspaceDeletedEventSchema,
  sessionWorkChangedEventSchema,
  sessionStatusChangedEventSchema,
  goalUpdatedEventSchema,
  skillActivatedEventSchema,
  pluginCommandActivatedEventSchema,
  turnStartedEventSchema,
  turnEndedEventSchema,
  turnStepStartedEventSchema,
  turnStepCompletedEventSchema,
  turnStepRetryingEventSchema,
  turnStepInterruptedEventSchema,
  assistantDeltaEventSchema,
  hookResultEventSchema,
  thinkingDeltaEventSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolProgressEventSchema,
  shellOutputEventSchema,
  shellStartedEventSchema,
  shellCompletedEventSchema,
  toolResultEventSchema,
  toolListUpdatedEventSchema,
  mcpServerStatusEventSchema,
  subagentSpawnedEventSchema,
  subagentStartedEventSchema,
  subagentSuspendedEventSchema,
  subagentCompletedEventSchema,
  subagentFailedEventSchema,
  compactionStartedEventSchema,
  compactionBlockedEventSchema,
  compactionCancelledEventSchema,
  compactionCompletedEventSchema,
  taskStartedEventSchema,
  taskTerminatedEventSchema,
  backgroundTaskStartedEventSchema,
  backgroundTaskTerminatedEventSchema,
  cronFiredEventSchema,
  promptSubmittedEventSchema,
  promptCompletedEventSchema,
  promptAbortedEventSchema,
  promptSteeredEventSchema,
]);

export const eventSchema = agentEventSchema.and(
  z.object({
    agentId: z.string(),
    sessionId: z.string(),
  }),
);
