/**
 * Zod schema half of the v1 event catalog (`packages/protocol/src/events.ts`),
 * ported verbatim for byte-level AsyncAPI/JSON-Schema compatibility. Interface
 * declarations and the deprecated volatile-event helpers are intentionally not
 * ported; `satisfies z.ZodType<T>` clauses are kept only where `T` is
 * importable from an agent-core-v2 leaf path and dropped elsewhere (dropped
 * clauses do not affect the emitted JSON Schema).
 */
import { z } from 'zod';

import { isoDateTimeSchema } from '@moonshot-ai/agent-core-v2/_base/utils/isoDateTime';
import type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type {
  CompactionSummaryOrigin,
  CronJobOrigin,
  CronMissedOrigin,
  HookResultOrigin,
  InjectionOrigin,
  PluginCommandOrigin,
  RetryOrigin,
  ShellCommandOrigin,
  SkillActivationOrigin,
  SkillSource,
  SystemTriggerOrigin,
  TaskOrigin,
  UserPromptOrigin,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import { messageContentSchema } from '@moonshot-ai/agent-core-v2/agent/contextMemory/protocolMessage';
import type { HookResultEvent } from '@moonshot-ai/agent-core-v2/agent/externalHooks/externalHooksService';
import type {
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
} from '@moonshot-ai/agent-core-v2/agent/fullCompaction/compactionOps';
import type { CompactionResult } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/types';
import type {
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeKind,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '@moonshot-ai/agent-core-v2/agent/goal/types';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type {
  McpServerStatusEvent,
  McpServerStatusPayload,
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
} from '@moonshot-ai/agent-core-v2/agent/mcp/mcpService';
import type { McpOAuthAuthorizationUrlUpdateData } from '@moonshot-ai/agent-core-v2/agent/mcp/tools/auth';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type { WarningEvent } from '@moonshot-ai/agent-core-v2/agent/profile/profileService';
import type { PluginCommandActivatedEvent } from '@moonshot-ai/agent-core-v2/agent/rpc/rpcService';
import type {
  ShellCompletedEvent,
  ShellOutputEvent,
  ShellStartedEvent,
} from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommandService';

import type { TurnStepRetryingEvent } from '@moonshot-ai/agent-core-v2/agent/stepRetry/stepRetryService';
import type { AgentTaskStatus } from '@moonshot-ai/agent-core-v2/agent/task/types';
import type {
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { UsageStatus } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { FinishReason } from '@moonshot-ai/agent-core-v2/kosong/contract/provider';
import type { TokenUsage } from '@moonshot-ai/agent-core-v2/kosong/contract/usage';
import type {
  SubagentCompletedEvent,
  SubagentFailedEvent,
  SubagentSpawnedEvent,
  SubagentStartedEvent,
} from '@moonshot-ai/agent-core-v2/session/subagent/mirrorAgentRun';
import type { SubagentSuspendedEvent } from '@moonshot-ai/agent-core-v2/session/swarm/sessionSwarmService';
import type { ToolUpdate } from '@moonshot-ai/agent-core-v2/tool/toolContract';

import { ToolInputDisplaySchema } from './display';
import { configResponseSchema } from './rest-config';
import { sessionPendingInteractionSchema, sessionSchema } from './session';
import { workspaceSchema } from './workspace';

export const tokenUsageSchema = z.object({
  inputOther: z.number(),
  output: z.number(),
  inputCacheRead: z.number(),
  inputCacheCreation: z.number(),
}) satisfies z.ZodType<TokenUsage>;

export const finishReasonSchema = z.enum([
  'completed',
  'tool_calls',
  'truncated',
  'filtered',
  'paused',
  'other',
]) satisfies z.ZodType<FinishReason>;

export const usageStatusSchema = z.object({
  byModel: z.record(z.string(), tokenUsageSchema).optional(),
  currentTurn: tokenUsageSchema.optional(),
  total: tokenUsageSchema.optional(),
}) satisfies z.ZodType<UsageStatus>;

export const permissionModeSchema = z.enum(['manual', 'yolo', 'auto']) satisfies z.ZodType<PermissionMode>;

export const skillSourceSchema = z.enum(['project', 'user', 'extra', 'builtin']) satisfies z.ZodType<SkillSource>;

export const userPromptOriginSchema = z.object({
  kind: z.literal('user'),
}) satisfies z.ZodType<UserPromptOrigin>;

export const skillActivationOriginSchema = z.object({
  kind: z.literal('skill_activation'),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
  skillType: z.string().optional(),
  skillPath: z.string().optional(),
  skillSource: skillSourceSchema.optional(),
}) satisfies z.ZodType<SkillActivationOrigin>;

export const pluginCommandOriginSchema = z.object({
  kind: z.literal('plugin_command'),
  activationId: z.string(),
  pluginId: z.string(),
  commandName: z.string(),
  commandArgs: z.string().optional(),
  trigger: z.literal('user-slash'),
}) satisfies z.ZodType<PluginCommandOrigin>;

export const injectionOriginSchema = z.object({
  kind: z.literal('injection'),
  variant: z.string(),
}) satisfies z.ZodType<InjectionOrigin>;

export const shellCommandOriginSchema = z.object({
  kind: z.literal('shell_command'),
  phase: z.enum(['input', 'output']),
  isError: z.boolean().optional(),
}) satisfies z.ZodType<ShellCommandOrigin>;

export const compactionSummaryOriginSchema = z.object({
  kind: z.literal('compaction_summary'),
}) satisfies z.ZodType<CompactionSummaryOrigin>;

export const systemTriggerOriginSchema = z.object({
  kind: z.literal('system_trigger'),
  name: z.string(),
}) satisfies z.ZodType<SystemTriggerOrigin>;

export const taskLifecycleStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]) satisfies z.ZodType<AgentTaskStatus>;

export const taskOriginSchema = z.object({
  kind: z.literal('task'),
  taskId: z.string(),
  status: taskLifecycleStatusSchema,
  notificationId: z.string(),
}) satisfies z.ZodType<TaskOrigin>;

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
}) satisfies z.ZodType<CronJobOrigin>;

export const cronMissedOriginSchema = z.object({
  kind: z.literal('cron_missed'),
  count: z.number(),
}) satisfies z.ZodType<CronMissedOrigin>;

export const hookResultOriginSchema = z.object({
  kind: z.literal('hook_result'),
  event: z.string(),
  blocked: z.boolean().optional(),
}) satisfies z.ZodType<HookResultOrigin>;

export const retryOriginSchema = z.object({
  kind: z.literal('retry'),
  trigger: z.string().optional(),
}) satisfies z.ZodType<RetryOrigin>;

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

export const goalStatusSchema = z.enum(['active', 'paused', 'blocked', 'complete']) satisfies z.ZodType<GoalStatus>;

export const goalActorSchema = z.enum(['user', 'model', 'runtime', 'system']) satisfies z.ZodType<GoalActor>;

export const goalBudgetLimitsSchema = z.object({
  tokenBudget: z.number().optional(),
  turnBudget: z.number().optional(),
  wallClockBudgetMs: z.number().optional(),
}) satisfies z.ZodType<GoalBudgetLimits>;

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
}) satisfies z.ZodType<GoalBudgetReport>;

export const goalSnapshotSchema = z.object({
  goalId: z.string(),
  objective: z.string(),
  completionCriterion: z.string().optional(),
  status: goalStatusSchema,
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  wallClockMs: z.number(),
  budget: goalBudgetReportSchema,
  terminalReason: z.string().optional(),
}) satisfies z.ZodType<GoalSnapshot>;

export const goalToolResultSchema = z.object({
  goal: goalSnapshotSchema.nullable(),
}) satisfies z.ZodType<GoalToolResult>;

export const goalChangeStatsSchema = z.object({
  turnsUsed: z.number(),
  tokensUsed: z.number(),
  wallClockMs: z.number(),
}) satisfies z.ZodType<GoalChangeStats>;

export const goalChangeKindSchema = z.enum(['lifecycle', 'completion']) satisfies z.ZodType<GoalChangeKind>;

export const goalChangeSchema = z.object({
  kind: goalChangeKindSchema,
  status: goalStatusSchema.optional(),
  reason: z.string().optional(),
  stats: goalChangeStatsSchema.optional(),
  actor: goalActorSchema.optional(),
}) satisfies z.ZodType<GoalChange>;

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

export const kimiErrorPayloadSchema: z.ZodType<unknown> = z.lazy(
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
}) satisfies z.ZodType<CompactionResult>;

export const toolUpdateSchema = z.object({
  kind: z.enum(['stdout', 'stderr', 'progress', 'status', 'custom']),
  text: z.string().optional(),
  percent: z.number().optional(),
  customKind: z.string().optional(),
  customData: z.unknown().optional(),
}) satisfies z.ZodType<ToolUpdate>;

export const mcpOAuthAuthorizationUrlUpdateDataSchema = z.object({
  serverName: z.string(),
  authorizationUrl: z.string(),
}) satisfies z.ZodType<McpOAuthAuthorizationUrlUpdateData>;

export const turnEndReasonSchema = z.enum(['completed', 'cancelled', 'failed', 'blocked']) satisfies z.ZodType<TurnEndReason>;

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
}) satisfies z.ZodType<PluginCommandActivatedEvent>;

export const errorEventSchema = kimiErrorPayloadObjectSchema.extend({
  type: z.literal('error'),
});

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  message: z.string(),
  code: z.string().optional(),
}) satisfies z.ZodType<WarningEvent>;

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
}) satisfies z.ZodType<TurnStepStartedEvent>;

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
}) satisfies z.ZodType<TurnStepCompletedEvent>;

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
}) satisfies z.ZodType<TurnStepRetryingEvent>;

export const turnStepInterruptedEventSchema = z.object({
  type: z.literal('turn.step.interrupted'),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  reason: z.string(),
  message: z.string().optional(),
}) satisfies z.ZodType<TurnStepInterruptedEvent>;

export const assistantDeltaEventSchema = z.object({
  type: z.literal('assistant.delta'),
  turnId: z.number(),
  delta: z.string(),
}) satisfies z.ZodType<AssistantDeltaEvent>;

export const hookResultEventSchema = z.object({
  type: z.literal('hook.result'),
  turnId: z.number().optional(),
  hookEvent: z.string(),
  content: z.string(),
  blocked: z.boolean().optional(),
}) satisfies z.ZodType<HookResultEvent>;

export const thinkingDeltaEventSchema = z.object({
  type: z.literal('thinking.delta'),
  turnId: z.number(),
  delta: z.string(),
}) satisfies z.ZodType<ThinkingDeltaEvent>;

export const toolCallDeltaEventSchema = z.object({
  type: z.literal('tool.call.delta'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string().optional(),
  argumentsPart: z.string().optional(),
}) satisfies z.ZodType<ToolCallDeltaEvent>;

export const toolCallStartedEventSchema = z.object({
  type: z.literal('tool.call.started'),
  turnId: z.number(),
  toolCallId: z.string(),
  name: z.string(),
  args: z.unknown(),
  description: z.string().optional(),
  display: ToolInputDisplaySchema.optional(),
}) satisfies z.ZodType<ToolCallStartedEvent>;

export const toolProgressEventSchema = z.object({
  type: z.literal('tool.progress'),
  turnId: z.number(),
  toolCallId: z.string(),
  update: toolUpdateSchema,
}) satisfies z.ZodType<ToolProgressEvent>;

export const shellOutputEventSchema = z.object({
  type: z.literal('shell.output'),
  commandId: z.string(),
  update: toolUpdateSchema,
  taskId: z.string().optional(),
}) satisfies z.ZodType<ShellOutputEvent>;

export const shellStartedEventSchema = z.object({
  type: z.literal('shell.started'),
  commandId: z.string(),
  taskId: z.string(),
}) satisfies z.ZodType<ShellStartedEvent>;

export const shellCompletedEventSchema = z.object({
  type: z.literal('shell.completed'),
  commandId: z.string(),
  isError: z.boolean(),
  taskId: z.string().optional(),
}) satisfies z.ZodType<ShellCompletedEvent>;

export const toolResultEventSchema = z.object({
  type: z.literal('tool.result'),
  turnId: z.number(),
  toolCallId: z.string(),
  output: z.unknown(),
  isError: z.boolean().optional(),
  synthetic: z.boolean().optional(),
}) satisfies z.ZodType<ToolResultEvent>;

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
}) satisfies z.ZodType<SubagentSpawnedEvent>;

export const subagentStartedEventSchema = z.object({
  type: z.literal('subagent.started'),
  subagentId: z.string(),
}) satisfies z.ZodType<SubagentStartedEvent>;

export const subagentSuspendedEventSchema = z.object({
  type: z.literal('subagent.suspended'),
  subagentId: z.string(),
  reason: z.string(),
}) satisfies z.ZodType<SubagentSuspendedEvent>;

export const subagentCompletedEventSchema = z.object({
  type: z.literal('subagent.completed'),
  subagentId: z.string(),
  resultSummary: z.string(),
  usage: tokenUsageSchema.optional(),
  contextTokens: z.number().optional(),
}) satisfies z.ZodType<SubagentCompletedEvent>;

export const subagentFailedEventSchema = z.object({
  type: z.literal('subagent.failed'),
  subagentId: z.string(),
  error: z.string(),
}) satisfies z.ZodType<SubagentFailedEvent>;

export const compactionStartedEventSchema = z.object({
  type: z.literal('compaction.started'),
  trigger: z.enum(['manual', 'auto']),
  instruction: z.string().optional(),
}) satisfies z.ZodType<CompactionStartedEvent>;

export const compactionBlockedEventSchema = z.object({
  type: z.literal('compaction.blocked'),
  turnId: z.number().optional(),
}) satisfies z.ZodType<CompactionBlockedEvent>;

export const compactionCancelledEventSchema = z.object({
  type: z.literal('compaction.cancelled'),
}) satisfies z.ZodType<CompactionCancelledEvent>;

export const compactionCompletedEventSchema = z.object({
  type: z.literal('compaction.completed'),
  result: compactionResultSchema,
}) satisfies z.ZodType<CompactionCompletedEvent>;

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
]) satisfies z.ZodType<ToolListUpdatedReason>;

export const toolListUpdatedEventSchema = z.object({
  type: z.literal('tool.list.updated'),
  reason: toolListUpdatedReasonSchema,
  serverName: z.string(),
}) satisfies z.ZodType<ToolListUpdatedEvent>;

export const mcpServerStatusPayloadSchema = z.object({
  name: z.string(),
  transport: z.enum(['stdio', 'http']),
  status: z.enum(['pending', 'connected', 'failed', 'disabled', 'needs-auth']),
  toolCount: z.number(),
  error: z.string().optional(),
}) satisfies z.ZodType<McpServerStatusPayload>;

export const mcpServerStatusEventSchema = z.object({
  type: z.literal('mcp.server.status'),
  server: mcpServerStatusPayloadSchema,
}) satisfies z.ZodType<McpServerStatusEvent>;

export const agentEventSchema = z.discriminatedUnion('type', [
  errorEventSchema,
  warningEventSchema,
  agentStatusUpdatedEventSchema,
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
