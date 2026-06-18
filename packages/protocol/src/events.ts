import { z } from 'zod';

import { ToolInputDisplaySchema, type ToolInputDisplay } from './display';
import { messageContentSchema, type MessageContent } from './message';
import { sessionSchema, sessionStatusSchema, type Session, type SessionStatus } from './session';
import { isoDateTimeSchema } from './time';
import { configResponseSchema, type ConfigResponse } from './rest/config';
import { workspaceSchema, type Workspace } from './workspace';

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
}

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

export interface UserPromptOrigin {
  readonly kind: 'user';
}

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string;
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export type AgentCoreBackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: AgentCoreBackgroundTaskStatus;
  readonly notificationId: string;
}

export interface CronJobOrigin {
  readonly kind: 'cron_job';
  readonly jobId: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly coalescedCount: number;
  readonly stale: boolean;
}

export interface CronMissedOrigin {
  readonly kind: 'cron_missed';
  readonly count: number;
}

export interface HookResultOrigin {
  readonly kind: 'hook_result';
  readonly event: string;
  readonly blocked?: boolean;
}

export interface RetryOrigin {
  readonly kind: 'retry';
  readonly trigger?: string;
}

export type PromptOrigin =
  | UserPromptOrigin
  | SkillActivationOrigin
  | InjectionOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete';
export type GoalActor = 'user' | 'model' | 'runtime' | 'system';

export interface GoalBudgetLimits {
  readonly tokenBudget?: number;
  readonly turnBudget?: number;
  readonly wallClockBudgetMs?: number;
}

export interface GoalBudgetReport {
  readonly tokenBudget: number | null;
  readonly turnBudget: number | null;
  readonly wallClockBudgetMs: number | null;
  readonly remainingTokens: number | null;
  readonly remainingTurns: number | null;
  readonly remainingWallClockMs: number | null;
  readonly tokenBudgetReached: boolean;
  readonly turnBudgetReached: boolean;
  readonly wallClockBudgetReached: boolean;
  readonly overBudget: boolean;
}

export interface GoalSnapshot {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budget: GoalBudgetReport;
  readonly terminalReason?: string;
}

export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

export type GoalChangeKind = 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export type KimiErrorCode =
  | 'config.invalid'
  | 'session.not_found'
  | 'session.already_exists'
  | 'session.id_invalid'
  | 'session.id_required'
  | 'session.id_empty'
  | 'session.title_empty'
  | 'session.state_not_found'
  | 'session.state_invalid'
  | 'session.fork_active_turn'
  | 'session.export_not_found'
  | 'session.export_missing_version'
  | 'session.closed'
  | 'session.permission_mode_invalid'
  | 'session.thinking_empty'
  | 'session.model_empty'
  | 'session.plan_mode_invalid'
  | 'session.approval_handler_error'
  | 'session.question_handler_error'
  | 'session.init_failed'
  | 'agent.not_found'
  | 'turn.agent_busy'
  | 'goal.already_exists'
  | 'goal.not_found'
  | 'goal.objective_empty'
  | 'goal.objective_too_long'
  | 'goal.status_invalid'
  | 'goal.metadata_reserved'
  | 'goal.not_resumable'
  | 'model.not_configured'
  | 'model.config_invalid'
  | 'auth.login_required'
  | 'context.overflow'
  | 'loop.max_steps_exceeded'
  | 'provider.api_error'
  | 'provider.rate_limit'
  | 'provider.auth_error'
  | 'provider.connection_error'
  | 'skill.not_found'
  | 'skill.type_unsupported'
  | 'skill.name_empty'
  | 'records.write_failed'
  | 'compaction.failed'
  | 'compaction.unable'
  | 'background.task_id_empty'
  | 'mcp.server_not_found'
  | 'mcp.server_disabled'
  | 'mcp.startup_failed'
  | 'mcp.tool_name_collision'
  | 'plugin.not_found'
  | 'plugin.load_failed'
  | 'request.invalid'
  | 'request.work_dir_required'
  | 'request.prompt_input_empty'
  | 'shell.git_bash_not_found'
  | 'not_implemented'
  | 'internal';

export interface KimiErrorPayload {
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
}

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentCoreBackgroundTaskStatus;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface QuestionBackgroundTaskInfo extends BackgroundTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type BackgroundTaskInfo =
  | ProcessBackgroundTaskInfo
  | AgentBackgroundTaskInfo
  | QuestionBackgroundTaskInfo;

export interface CompactionResult {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

export interface ToolUpdate {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom';
  readonly text?: string;
  readonly percent?: number;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = 'mcp.oauth.authorization_url';

export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
}

export type TurnEndReason = 'completed' | 'cancelled' | 'failed';

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly permission?: PermissionMode;
  readonly usage?: UsageStatus;
}

export interface SessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly title?: string;
  readonly patch?: Record<string, unknown>;
}

export interface SessionCreatedEvent {
  readonly type: 'event.session.created';
  readonly session: Session;
}

export interface WorkspaceCreatedEvent {
  readonly type: 'event.workspace.created';
  readonly workspace: Workspace;
}

export interface WorkspaceUpdatedEvent {
  readonly type: 'event.workspace.updated';
  readonly workspace: Workspace;
}

export interface WorkspaceDeletedEvent {
  readonly type: 'event.workspace.deleted';
  readonly workspace_id: string;
  readonly root: string;
}

export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: SessionStatus;
  readonly previous_status: SessionStatus;
  readonly current_prompt_id?: string;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

export interface GoalUpdatedEvent {
  readonly type: 'goal.updated';
  readonly snapshot: GoalSnapshot | null;
  readonly change?: GoalChange;
}

export interface SkillActivatedEvent {
  readonly type: 'skill.activated';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillPath?: string;
  readonly skillSource?: SkillSource;
}

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

export interface TurnStartedEvent {
  readonly type: 'turn.started';
  readonly turnId: number;
  readonly origin: PromptOrigin;
}

export interface TurnEndedEvent {
  readonly type: 'turn.ended';
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
}

export interface TurnStepStartedEvent {
  readonly type: 'turn.step.started';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
}

export interface TurnStepCompletedEvent {
  readonly type: 'turn.step.completed';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly usage?: TokenUsage;
  readonly finishReason?: string;
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  readonly providerFinishReason?: FinishReason;
  readonly rawFinishReason?: string;
}

export interface TurnStepRetryingEvent {
  readonly type: 'turn.step.retrying';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface TurnStepInterruptedEvent {
  readonly type: 'turn.step.interrupted';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly reason: string;
  readonly message?: string;
}

export interface AssistantDeltaEvent {
  readonly type: 'assistant.delta';
  readonly turnId: number;
  readonly delta: string;
}

export interface HookResultEvent {
  readonly type: 'hook.result';
  readonly turnId: number;
  readonly hookEvent: string;
  readonly content: string;
  readonly blocked?: boolean;
}

export interface ThinkingDeltaEvent {
  readonly type: 'thinking.delta';
  readonly turnId: number;
  readonly delta: string;
}

export interface ToolCallDeltaEvent {
  readonly type: 'tool.call.delta';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name?: string;
  readonly argumentsPart?: string;
}

export interface ToolCallStartedEvent {
  readonly type: 'tool.call.started';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
}

export interface ToolProgressEvent {
  readonly type: 'tool.progress';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export interface ToolResultEvent {
  readonly type: 'tool.result';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly output: unknown;
  readonly isError?: boolean;
  readonly synthetic?: boolean;
}

export interface SubagentSpawnedEvent {
  readonly type: 'subagent.spawned';
  readonly subagentId: string;
  readonly subagentName: string;
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly parentAgentId?: string;
  readonly description?: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
}

export interface SubagentStartedEvent {
  readonly type: 'subagent.started';
  readonly subagentId: string;
}

export interface SubagentSuspendedEvent {
  readonly type: 'subagent.suspended';
  readonly subagentId: string;
  readonly reason: string;
}

export interface SubagentCompletedEvent {
  readonly type: 'subagent.completed';
  readonly subagentId: string;
  readonly resultSummary: string;
  readonly usage?: TokenUsage;
  readonly contextTokens?: number;
}

export interface SubagentFailedEvent {
  readonly type: 'subagent.failed';
  readonly subagentId: string;
  readonly error: string;
}

export interface CompactionStartedEvent {
  readonly type: 'compaction.started';
  readonly trigger: 'manual' | 'auto';
  readonly instruction?: string;
}

export interface CompactionBlockedEvent {
  readonly type: 'compaction.blocked';
  readonly turnId?: number;
}

export interface CompactionCancelledEvent {
  readonly type: 'compaction.cancelled';
}

export interface CompactionCompletedEvent {
  readonly type: 'compaction.completed';
  readonly result: CompactionResult;
}

export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: BackgroundTaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: BackgroundTaskInfo;
}

export interface CronFiredEvent {
  readonly type: 'cron.fired';
  readonly origin: CronJobOrigin;
  readonly prompt: string;
}

export interface PromptSubmittedEvent {
  readonly type: 'prompt.submitted';
  readonly promptId: string;
  readonly userMessageId: string;
  readonly status: 'running' | 'queued';
  readonly content: readonly MessageContent[];
  readonly createdAt: string;
}

export type ToolListUpdatedReason = 'mcp.connected' | 'mcp.disconnected' | 'mcp.failed';

export interface ToolListUpdatedEvent {
  readonly type: 'tool.list.updated';
  readonly reason: ToolListUpdatedReason;
  readonly serverName: string;
}

export interface McpServerStatusEvent {
  readonly type: 'mcp.server.status';
  readonly server: McpServerStatusPayload;
}

export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export type AgentEvent =
  | ErrorEvent
  | WarningEvent
  | AgentStatusUpdatedEvent
  | SessionMetaUpdatedEvent
  | SessionCreatedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | GoalUpdatedEvent
  | SkillActivatedEvent
  | TurnStartedEvent
  | TurnEndedEvent
  | TurnStepStartedEvent
  | TurnStepCompletedEvent
  | TurnStepRetryingEvent
  | TurnStepInterruptedEvent
  | AssistantDeltaEvent
  | HookResultEvent
  | ThinkingDeltaEvent
  | ToolCallDeltaEvent
  | ToolCallStartedEvent
  | ToolProgressEvent
  | ToolResultEvent
  | ToolListUpdatedEvent
  | McpServerStatusEvent
  | SubagentSpawnedEvent
  | SubagentStartedEvent
  | SubagentSuspendedEvent
  | SubagentCompletedEvent
  | SubagentFailedEvent
  | CompactionStartedEvent
  | CompactionBlockedEvent
  | CompactionCancelledEvent
  | CompactionCompletedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | CronFiredEvent
  | PromptSubmittedEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };

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

export const injectionOriginSchema = z.object({
  kind: z.literal('injection'),
  variant: z.string(),
}) satisfies z.ZodType<InjectionOrigin>;

export const compactionSummaryOriginSchema = z.object({
  kind: z.literal('compaction_summary'),
}) satisfies z.ZodType<CompactionSummaryOrigin>;

export const systemTriggerOriginSchema = z.object({
  kind: z.literal('system_trigger'),
  name: z.string(),
}) satisfies z.ZodType<SystemTriggerOrigin>;

export const agentCoreBackgroundTaskStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'timed_out',
  'killed',
  'lost',
]) satisfies z.ZodType<AgentCoreBackgroundTaskStatus>;

export const backgroundTaskOriginSchema = z.object({
  kind: z.literal('background_task'),
  taskId: z.string(),
  status: agentCoreBackgroundTaskStatusSchema,
  notificationId: z.string(),
}) satisfies z.ZodType<BackgroundTaskOrigin>;

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
  injectionOriginSchema,
  compactionSummaryOriginSchema,
  systemTriggerOriginSchema,
  backgroundTaskOriginSchema,
  cronJobOriginSchema,
  cronMissedOriginSchema,
  hookResultOriginSchema,
  retryOriginSchema,
]) satisfies z.ZodType<PromptOrigin>;

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
  'session.export_not_found',
  'session.export_missing_version',
  'session.closed',
  'session.permission_mode_invalid',
  'session.thinking_empty',
  'session.model_empty',
  'session.plan_mode_invalid',
  'session.approval_handler_error',
  'session.question_handler_error',
  'session.init_failed',
  'agent.not_found',
  'turn.agent_busy',
  'goal.already_exists',
  'goal.not_found',
  'goal.objective_empty',
  'goal.objective_too_long',
  'goal.status_invalid',
  'goal.metadata_reserved',
  'goal.not_resumable',
  'model.not_configured',
  'model.config_invalid',
  'auth.login_required',
  'context.overflow',
  'loop.max_steps_exceeded',
  'provider.api_error',
  'provider.rate_limit',
  'provider.auth_error',
  'provider.connection_error',
  'skill.not_found',
  'skill.type_unsupported',
  'skill.name_empty',
  'records.write_failed',
  'compaction.failed',
  'compaction.unable',
  'background.task_id_empty',
  'mcp.server_not_found',
  'mcp.server_disabled',
  'mcp.startup_failed',
  'mcp.tool_name_collision',
  'plugin.not_found',
  'plugin.load_failed',
  'request.invalid',
  'request.work_dir_required',
  'request.prompt_input_empty',
  'shell.git_bash_not_found',
  'not_implemented',
  'internal',
]) satisfies z.ZodType<KimiErrorCode>;

export const kimiErrorPayloadSchema = z.object({
  code: kimiErrorCodeSchema,
  message: z.string(),
  name: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
}) satisfies z.ZodType<KimiErrorPayload>;

export const backgroundTaskInfoBaseSchema = z.object({
  taskId: z.string(),
  description: z.string(),
  status: agentCoreBackgroundTaskStatusSchema,
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  stopReason: z.string().optional(),
  terminalNotificationSuppressed: z.boolean().optional(),
  timeoutMs: z.number().optional(),
}) satisfies z.ZodType<BackgroundTaskInfoBase>;

export const processBackgroundTaskInfoSchema = backgroundTaskInfoBaseSchema.extend({
  kind: z.literal('process'),
  command: z.string(),
  pid: z.number(),
  exitCode: z.number().nullable(),
}) satisfies z.ZodType<ProcessBackgroundTaskInfo>;

export const agentBackgroundTaskInfoSchema = backgroundTaskInfoBaseSchema.extend({
  kind: z.literal('agent'),
  agentId: z.string().optional(),
  subagentType: z.string().optional(),
}) satisfies z.ZodType<AgentBackgroundTaskInfo>;

export const questionBackgroundTaskInfoSchema = backgroundTaskInfoBaseSchema.extend({
  kind: z.literal('question'),
  questionCount: z.number(),
  toolCallId: z.string().optional(),
}) satisfies z.ZodType<QuestionBackgroundTaskInfo>;

export const backgroundTaskInfoSchema = z.discriminatedUnion('kind', [
  processBackgroundTaskInfoSchema,
  agentBackgroundTaskInfoSchema,
  questionBackgroundTaskInfoSchema,
]) satisfies z.ZodType<BackgroundTaskInfo>;

export const compactionResultSchema = z.object({
  summary: z.string(),
  compactedCount: z.number(),
  tokensBefore: z.number(),
  tokensAfter: z.number(),
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

export const turnEndReasonSchema = z.enum(['completed', 'cancelled', 'failed']) satisfies z.ZodType<TurnEndReason>;

export const agentStatusUpdatedEventSchema = z.object({
  type: z.literal('agent.status.updated'),
  model: z.string().optional(),
  contextTokens: z.number().optional(),
  maxContextTokens: z.number().optional(),
  contextUsage: z.number().optional(),
  planMode: z.boolean().optional(),
  swarmMode: z.boolean().optional(),
  permission: permissionModeSchema.optional(),
  usage: usageStatusSchema.optional(),
}) satisfies z.ZodType<AgentStatusUpdatedEvent>;

export const sessionMetaUpdatedEventSchema = z.object({
  type: z.literal('session.meta.updated'),
  title: z.string().optional(),
  patch: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<SessionMetaUpdatedEvent>;

export const sessionCreatedEventSchema = z.object({
  type: z.literal('event.session.created'),
  session: sessionSchema,
}) satisfies z.ZodType<SessionCreatedEvent>;

export const workspaceCreatedEventSchema = z.object({
  type: z.literal('event.workspace.created'),
  workspace: workspaceSchema,
}) satisfies z.ZodType<WorkspaceCreatedEvent>;

export const workspaceUpdatedEventSchema = z.object({
  type: z.literal('event.workspace.updated'),
  workspace: workspaceSchema,
}) satisfies z.ZodType<WorkspaceUpdatedEvent>;

export const workspaceDeletedEventSchema = z.object({
  type: z.literal('event.workspace.deleted'),
  workspace_id: z.string().min(1),
  root: z.string().min(1),
}) satisfies z.ZodType<WorkspaceDeletedEvent>;

export const sessionStatusChangedEventSchema = z.object({
  type: z.literal('event.session.status_changed'),
  status: sessionStatusSchema,
  previous_status: sessionStatusSchema,
  current_prompt_id: z.string().min(1).optional(),
}) satisfies z.ZodType<SessionStatusChangedEvent>;

export const configChangedEventSchema = z.object({
  type: z.literal('event.config.changed'),
  changedFields: z.array(z.string()),
  config: configResponseSchema,
}) satisfies z.ZodType<ConfigChangedEvent>;

export const goalUpdatedEventSchema = z.object({
  type: z.literal('goal.updated'),
  snapshot: goalSnapshotSchema.nullable(),
  change: goalChangeSchema.optional(),
}) satisfies z.ZodType<GoalUpdatedEvent>;

export const skillActivatedEventSchema = z.object({
  type: z.literal('skill.activated'),
  activationId: z.string(),
  skillName: z.string(),
  skillArgs: z.string().optional(),
  trigger: z.enum(['user-slash', 'model-tool', 'nested-skill']),
  skillPath: z.string().optional(),
  skillSource: skillSourceSchema.optional(),
}) satisfies z.ZodType<SkillActivatedEvent>;

export const errorEventSchema = kimiErrorPayloadSchema.extend({
  type: z.literal('error'),
}) satisfies z.ZodType<ErrorEvent>;

export const warningEventSchema = z.object({
  type: z.literal('warning'),
  message: z.string(),
  code: z.string().optional(),
}) satisfies z.ZodType<WarningEvent>;

export const turnStartedEventSchema = z.object({
  type: z.literal('turn.started'),
  turnId: z.number(),
  origin: promptOriginSchema,
}) satisfies z.ZodType<TurnStartedEvent>;

export const turnEndedEventSchema = z.object({
  type: z.literal('turn.ended'),
  turnId: z.number(),
  reason: turnEndReasonSchema,
  error: kimiErrorPayloadSchema.optional(),
  durationMs: z.number().optional(),
}) satisfies z.ZodType<TurnEndedEvent>;

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
  turnId: z.number(),
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

export const backgroundTaskStartedEventSchema = z.object({
  type: z.literal('background.task.started'),
  info: backgroundTaskInfoSchema,
}) satisfies z.ZodType<BackgroundTaskStartedEvent>;

export const backgroundTaskTerminatedEventSchema = z.object({
  type: z.literal('background.task.terminated'),
  info: backgroundTaskInfoSchema,
}) satisfies z.ZodType<BackgroundTaskTerminatedEvent>;

export const cronFiredEventSchema = z.object({
  type: z.literal('cron.fired'),
  origin: cronJobOriginSchema,
  prompt: z.string(),
}) satisfies z.ZodType<CronFiredEvent>;

export const promptSubmittedEventSchema = z.object({
  type: z.literal('prompt.submitted'),
  promptId: z.string(),
  userMessageId: z.string(),
  status: z.enum(['running', 'queued']),
  content: z.array(messageContentSchema),
  createdAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptSubmittedEvent>;

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
  sessionStatusChangedEventSchema,
  goalUpdatedEventSchema,
  skillActivatedEventSchema,
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
  backgroundTaskStartedEventSchema,
  backgroundTaskTerminatedEventSchema,
  cronFiredEventSchema,
  promptSubmittedEventSchema,
]) satisfies z.ZodType<AgentEvent>;

export const eventSchema = agentEventSchema.and(
  z.object({
    agentId: z.string(),
    sessionId: z.string(),
  }),
) satisfies z.ZodType<Event>;

/**
 * Volatile (ephemeral) event types — the IM-style "typing indicator" class.
 *
 * Volatile events are NOT journaled and do NOT advance the per-session
 * durable `seq`. They are fanned out live with the current durable watermark
 * (`seq` = last durable seq, `volatile: true` on the envelope) and are never
 * replayed after a reconnect. Clients recover any state they convey from the
 * session snapshot (`GET /sessions/{sid}/snapshot` → `in_flight_turn`) or
 * other REST surfaces instead of delta replay.
 *
 * Everything not listed here is durable: journaled, seq-bearing, replayable.
 */
export const VOLATILE_EVENT_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'agent.status.updated',
] as const satisfies readonly AgentEvent['type'][];

export type VolatileEventType = (typeof VOLATILE_EVENT_TYPES)[number];

const volatileEventTypeSet: ReadonlySet<string> = new Set(VOLATILE_EVENT_TYPES);

export function isVolatileEventType(type: string): type is VolatileEventType {
  return volatileEventTypeSet.has(type);
}
