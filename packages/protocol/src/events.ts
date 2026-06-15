import type { ToolInputDisplay } from './display';

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
  | CronFiredEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };
