import { z } from 'zod';

import { ToolInputDisplaySchema, type ToolInputDisplay } from './display';
import { messageContentSchema, type MessageContent } from './message';
import {
  sessionPendingInteractionSchema,
  sessionSchema,
  type Session,
  type SessionPendingInteraction,
} from './session';
import { isoDateTimeSchema } from './time';
import { configResponseSchema, type ConfigResponse } from './rest/config';
import {
  providerRefreshChangeSchema,
  providerRefreshFailureSchema,
  type ProviderRefreshChange,
  type ProviderRefreshFailure,
} from './modelCatalog';
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

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  /** Only present on `phase: 'output'` — whether the command failed, so replay
   *  can colour stderr red only for actual failures (not warnings). */
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export type TaskLifecycleStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface TaskOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: TaskLifecycleStatus;
  readonly notificationId: string;
}

/**
 * Legacy spelling of `TaskOrigin` emitted by the pre-v2 agent core, which
 * identifies background-task notifications with `kind: 'background_task'`.
 * Retained so the wire `PromptOrigin` accepts turns steered by the legacy
 * engine; new code should emit `TaskOrigin` (`kind: 'task'`).
 */
export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: TaskLifecycleStatus;
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
  | PluginCommandOrigin
  | InjectionOrigin
  | ShellCommandOrigin
  | CompactionSummaryOrigin
  | SystemTriggerOrigin
  | TaskOrigin
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
  | 'session.undo_unavailable'
  | 'session.export_not_found'
  | 'session.export_missing_version'
  | 'session.export_output_conflict'
  | 'session.export_too_large'
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
  | 'goal.unsupported_agent'
  | 'model.not_configured'
  | 'model.config_invalid'
  | 'profile.thinking_alias_conflict'
  | 'profile.unknown'
  | 'profile.already_bound'
  | 'profile.not_bound'
  | 'model.not_found'
  | 'auth.login_required'
  | 'auth.provisioning_required'
  | 'auth.token_missing'
  | 'auth.token_unauthorized'
  | 'auth.model_not_resolved'
  | 'context.overflow'
  | 'loop.max_steps_exceeded'
  | 'provider.api_error'
  | 'provider.filtered'
  | 'provider.rate_limit'
  | 'provider.auth_error'
  | 'provider.connection_error'
  | 'provider.overloaded'
  | 'provider.not_found'
  | 'skill.not_found'
  | 'skill.type_unsupported'
  | 'skill.name_empty'
  | 'records.write_failed'
  | 'compaction.failed'
  | 'compaction.unable'
  | 'task.task_id_empty'
  | 'usage.turn_id_conflict'
  | 'mcp.server_not_found'
  | 'mcp.server_disabled'
  | 'mcp.startup_failed'
  | 'mcp.tool_name_collision'
  | 'message.not_found'
  | 'plugin.not_found'
  | 'plugin.load_failed'
  | 'request.invalid'
  | 'request.work_dir_required'
  | 'request.prompt_input_empty'
  | 'prompt.not_found'
  | 'prompt.already_completed'
  | 'session.busy'
  | 'shell.git_bash_not_found'
  | 'workspace.not_found'
  | 'terminal.not_found'
  | 'file.not_found'
  | 'file.too_large'
  | 'fs.path_not_found'
  | 'fs.permission_denied'
  | 'fs.path_escapes'
  | 'fs.is_directory'
  | 'fs.is_binary'
  | 'fs.too_large'
  | 'fs.already_exists'
  | 'fs.too_many_results'
  | 'fs.grep_timeout'
  | 'fs.git_unavailable'
  | 'os.fs.not_found'
  | 'os.fs.is_directory'
  | 'os.fs.not_directory'
  | 'os.fs.already_exists'
  | 'os.fs.permission_denied'
  | 'os.fs.not_empty'
  | 'os.fs.unavailable'
  | 'os.fs.unknown'
  | 'os.process.spawn_failed'
  | 'os.process.kill_failed'
  | 'storage.not_found'
  | 'storage.decode_failed'
  | 'storage.corrupted'
  | 'storage.io_failed'
  | 'storage.locked'
  | 'wire.duplicate_op'
  | 'wire.cycle'
  | 'wire.unknown_record'
  | 'validation.failed'
  | 'not_implemented'
  | 'internal';

export interface KimiErrorPayload {
  readonly code: KimiErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly cause?: KimiErrorPayload;
}

export interface TaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: TaskLifecycleStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

export interface ProcessTaskInfo extends TaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentTaskInfo extends TaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface QuestionTaskInfo extends TaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type TaskInfo =
  | ProcessTaskInfo
  | AgentTaskInfo
  | QuestionTaskInfo;

export interface CompactionResult {
  readonly summary: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /**
   * Number of real user messages kept verbatim ahead of the summary in the
   * post-compaction live context. Recorded so the wire-transcript reducer can
   * reproduce the live folded length without re-deriving it from the full
   * transcript (which still holds the untruncated originals of messages the
   * live context may have truncated, so the two would otherwise diverge).
   * Optional for backward compatibility with older wire records.
   */
  readonly keptUserMessageCount?: number;
  /**
   * Of `keptUserMessageCount`, how many messages form the head segment (the
   * oldest user input kept when the pool overflowed the budget). Present iff
   * the selection split into head + tail, in which case the live context also
   * holds one elision-marker message between the segments. Optional for
   * backward compatibility with older wire records.
   */
  readonly keptHeadUserMessageCount?: number;
  /**
   * Oldest messages trimmed from the summarizer input when the compaction
   * request overflowed the model window; not covered by the produced summary.
   * Mirrors agent-core's `CompactionResult.droppedCount`; optional for backward
   * compatibility.
   */
  readonly droppedCount?: number;
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

export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export type AgentPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly since: number;
    }
  | {
      readonly kind: 'streaming';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly stream: 'assistant' | 'thinking' | 'tool_call';
      readonly toolCallId?: string;
      readonly toolName?: string;
      readonly since: number;
    }
  | {
      readonly kind: 'tool_call';
      readonly turnId: number;
      readonly step: number;
      readonly toolCallId: string;
      readonly name: string;
      readonly since: number;
    }
  | {
      readonly kind: 'retrying';
      readonly turnId: number;
      readonly step: number;
      readonly stepId: string;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorName?: string;
      readonly statusCode?: number;
      readonly since: number;
    }
  | {
      readonly kind: 'awaiting_approval';
      readonly turnId: number;
      readonly step?: number;
      readonly approval?: unknown;
      readonly since: number;
    }
  | {
      readonly kind: 'interrupted';
      readonly turnId: number;
      readonly step?: number;
      readonly reason: 'aborted' | 'max_steps' | 'error';
      readonly message?: string;
      readonly at: number;
    }
  | {
      readonly kind: 'ended';
      readonly turnId: number;
      readonly reason: TurnEndReason;
      readonly durationMs?: number;
      readonly at: number;
    };

export interface AgentStatusUpdatedEvent {
  readonly type: 'agent.status.updated';
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly planMode?: boolean;
  readonly swarmMode?: boolean;
  readonly permission?: PermissionMode;
  readonly usage?: UsageStatus;
  readonly phase?: AgentPhase;
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

export interface SessionWorkChangedEvent {
  readonly type: 'event.session.work_changed';
  readonly busy: boolean;
  /** Main-agent turn liveness, excluding background and sub-agent work. */
  readonly main_turn_active?: boolean;
  /** Highest-priority pending interaction for clients without a session subscription. */
  readonly pending_interaction?: SessionPendingInteraction;
  /** Outcome of the MAIN agent's most recent turn, when one has ended since
   *  activation (see `Session.last_turn_reason`). */
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}

/**
 * @deprecated Replaced by {@link SessionWorkChangedEvent}: awaiting states
 * ride the approval/question channels and outcomes ride turn.ended. Kept so
 * pre-change journals still parse during replay.
 */
export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly previous_status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly current_prompt_id?: string;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

/**
 * Pushed when the daemon refreshes provider model metadata (manual or
 * scheduled) and the effective catalog changed. Carries the per-provider
 * diff so clients can both refresh their model/provider caches and surface a
 * summary ("3 models added") without re-diffing the whole config.
 */
export interface ModelCatalogChangedEvent {
  readonly type: 'event.model_catalog.changed';
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
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

export interface PluginCommandActivatedEvent {
  readonly type: 'plugin_command.activated';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string;
  readonly trigger: 'user-slash';
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
  readonly prompt?: string;
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
  /**
   * Split of `llmFirstTokenLatencyMs`: in-process request-building time on the
   * client vs. network + API-server time to the first token. Both omitted when
   * the provider does not report the client/server boundary.
   */
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  /**
   * Split of `llmStreamDurationMs` (the decode window): time awaiting parts from
   * the provider vs. time processing parts in-process. Both omitted when the
   * provider stream did not report decode accounting.
   */
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
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
  readonly turnId?: number;
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

/**
 * Live stdout/stderr chunk from a user-initiated `!` shell command. Transient
 * (never persisted, never replayed) — the final output is still recorded once
 * via `context.append_message` on completion. `commandId` lets the TUI route
 * chunks to the matching live entry and drop stale events from a prior run.
 */
export interface ShellOutputEvent {
  readonly type: 'shell.output';
  readonly commandId: string;
  readonly update: ToolUpdate;
  readonly taskId?: string;
}

/**
 * Fired once when a `!` shell command's foreground process task is registered,
 * carrying the task id so the client can detach (ctrl+b) it. Transient.
 */
export interface ShellStartedEvent {
  readonly type: 'shell.started';
  readonly commandId: string;
  readonly taskId: string;
}

/**
 * Fired once when a foreground `!` shell command settles (success or
 * failure). Runs detached to background do NOT fire it — they report through
 * the task lifecycle instead. Transient, like the other `shell.*` events.
 */
export interface ShellCompletedEvent {
  readonly type: 'shell.completed';
  readonly commandId: string;
  readonly isError: boolean;
  readonly taskId?: string;
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
  readonly callerAgentId?: string;
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

export interface TaskStartedEvent {
  readonly type: 'task.started';
  readonly info: TaskInfo;
}

export interface TaskTerminatedEvent {
  readonly type: 'task.terminated';
  readonly info: TaskInfo;
}

/**
 * Legacy background-task lifecycle events emitted by the pre-v2 agent core
 * (`background.task.started` / `background.task.terminated`). The v2 engine
 * emits `task.started` / `task.terminated` instead; both spellings are kept in
 * the union so clients see a consistent event stream across engines.
 */
export interface BackgroundTaskStartedEvent {
  readonly type: 'background.task.started';
  readonly info: TaskInfo;
}

export interface BackgroundTaskTerminatedEvent {
  readonly type: 'background.task.terminated';
  readonly info: TaskInfo;
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
  readonly status: 'running' | 'queued' | 'blocked';
  readonly content: readonly MessageContent[];
  readonly createdAt: string;
}

export interface PromptCompletedEvent {
  readonly type: 'prompt.completed';
  readonly promptId: string;
  readonly finishedAt: string;
  readonly reason?: 'completed' | 'failed' | 'blocked';
}

export interface PromptAbortedEvent {
  readonly type: 'prompt.aborted';
  readonly promptId: string;
  readonly abortedAt: string;
}

export interface PromptSteeredEvent {
  readonly type: 'prompt.steered';
  readonly activePromptId: string;
  readonly promptIds: readonly string[];
  readonly content: readonly MessageContent[];
  readonly steeredAt: string;
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
  | SessionWorkChangedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | ModelCatalogChangedEvent
  | GoalUpdatedEvent
  | SkillActivatedEvent
  | PluginCommandActivatedEvent
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
  | ShellOutputEvent
  | ShellStartedEvent
  | ShellCompletedEvent
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
  | TaskStartedEvent
  | TaskTerminatedEvent
  | BackgroundTaskStartedEvent
  | BackgroundTaskTerminatedEvent
  | CronFiredEvent
  | PromptSubmittedEvent
  | PromptCompletedEvent
  | PromptAbortedEvent
  | PromptSteeredEvent;

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
]) satisfies z.ZodType<TaskLifecycleStatus>;

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
  'profile.unknown',
  'profile.already_bound',
  'profile.not_bound',
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
]) satisfies z.ZodType<KimiErrorCode>;

export const kimiErrorPayloadSchema: z.ZodType<KimiErrorPayload> = z.lazy(
  () => kimiErrorPayloadObjectSchema,
);

const kimiErrorPayloadObjectSchema = z.object({
  code: kimiErrorCodeSchema,
  message: z.string(),
  name: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  retryable: z.boolean(),
  cause: kimiErrorPayloadSchema.optional(),
}) satisfies z.ZodType<KimiErrorPayload>;

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
}) satisfies z.ZodType<TaskInfoBase>;

export const processTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('process'),
  command: z.string(),
  pid: z.number(),
  exitCode: z.number().nullable(),
}) satisfies z.ZodType<ProcessTaskInfo>;

export const agentTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('agent'),
  agentId: z.string().optional(),
  subagentType: z.string().optional(),
}) satisfies z.ZodType<AgentTaskInfo>;

export const questionTaskInfoSchema = taskInfoBaseSchema.extend({
  kind: z.literal('question'),
  questionCount: z.number(),
  toolCallId: z.string().optional(),
}) satisfies z.ZodType<QuestionTaskInfo>;

export const taskInfoSchema = z.discriminatedUnion('kind', [
  processTaskInfoSchema,
  agentTaskInfoSchema,
  questionTaskInfoSchema,
]) satisfies z.ZodType<TaskInfo>;

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
]) satisfies z.ZodType<AgentPhase>;

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

export const sessionWorkChangedEventSchema = z.object({
  type: z.literal('event.session.work_changed'),
  busy: z.boolean(),
  main_turn_active: z.boolean().optional(),
  pending_interaction: sessionPendingInteractionSchema.optional(),
  last_turn_reason: z.enum(['completed', 'cancelled', 'failed']).optional(),
}) satisfies z.ZodType<SessionWorkChangedEvent>;

/** @deprecated See {@link SessionStatusChangedEvent}. */
export const sessionStatusChangedEventSchema = z.object({
  type: z.literal('event.session.status_changed'),
  status: z.enum(['idle', 'running', 'awaiting_approval', 'awaiting_question', 'aborted']),
  previous_status: z.enum(['idle', 'running', 'awaiting_approval', 'awaiting_question', 'aborted']),
  current_prompt_id: z.string().min(1).optional(),
}) satisfies z.ZodType<SessionStatusChangedEvent>;

export const configChangedEventSchema = z.object({
  type: z.literal('event.config.changed'),
  changedFields: z.array(z.string()),
  config: configResponseSchema,
}) satisfies z.ZodType<ConfigChangedEvent>;

export const modelCatalogChangedEventSchema = z.object({
  type: z.literal('event.model_catalog.changed'),
  changed: z.array(providerRefreshChangeSchema),
  unchanged: z.array(z.string().min(1)),
  failed: z.array(providerRefreshFailureSchema),
}) satisfies z.ZodType<ModelCatalogChangedEvent>;

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
  prompt: z.string().optional(),
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
}) satisfies z.ZodType<TaskStartedEvent>;

export const taskTerminatedEventSchema = z.object({
  type: z.literal('task.terminated'),
  info: taskInfoSchema,
}) satisfies z.ZodType<TaskTerminatedEvent>;

export const backgroundTaskStartedEventSchema = z.object({
  type: z.literal('background.task.started'),
  info: taskInfoSchema,
}) satisfies z.ZodType<BackgroundTaskStartedEvent>;

export const backgroundTaskTerminatedEventSchema = z.object({
  type: z.literal('background.task.terminated'),
  info: taskInfoSchema,
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
  status: z.enum(['running', 'queued', 'blocked']),
  content: z.array(messageContentSchema),
  createdAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptSubmittedEvent>;

export const promptCompletedEventSchema = z.object({
  type: z.literal('prompt.completed'),
  promptId: z.string(),
  finishedAt: isoDateTimeSchema,
  reason: z.enum(['completed', 'failed', 'blocked']).optional(),
}) satisfies z.ZodType<PromptCompletedEvent>;

export const promptAbortedEventSchema = z.object({
  type: z.literal('prompt.aborted'),
  promptId: z.string(),
  abortedAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptAbortedEvent>;

export const promptSteeredEventSchema = z.object({
  type: z.literal('prompt.steered'),
  activePromptId: z.string(),
  promptIds: z.array(z.string()),
  content: z.array(messageContentSchema),
  steeredAt: isoDateTimeSchema,
}) satisfies z.ZodType<PromptSteeredEvent>;

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
  modelCatalogChangedEventSchema,
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
 *
 * @deprecated Use the server-side `isVolatileSignal`
 * (`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`) instead,
 * which owns volatile-vs-durable classification for the `wire` emission path.
 * The legacy `IAgentRecordService` (`record.on`) transport path still consumes
 * this until Phase 4 removes it; do not add new consumers.
 */
export const VOLATILE_EVENT_TYPES = [
  'assistant.delta',
  'thinking.delta',
  'tool.call.delta',
  'tool.progress',
  'shell.output',
  'shell.started',
  'shell.completed',
  'agent.status.updated',
] as const satisfies readonly AgentEvent['type'][];

export type VolatileEventType = (typeof VOLATILE_EVENT_TYPES)[number];

const volatileEventTypeSet: ReadonlySet<string> = new Set(VOLATILE_EVENT_TYPES);

/**
 * @deprecated Use the server-side `isVolatileSignal`
 * (`packages/kap-server/src/transport/ws/v1/sessionEventBroadcaster.ts`) instead,
 * which owns volatile-vs-durable classification for the `wire` emission path.
 * Retained only for the legacy `IAgentRecordService` (`record.on`) transport
 * path until Phase 4 removes it; do not add new consumers.
 */
export function isVolatileEventType(type: string): type is VolatileEventType {
  return volatileEventTypeSet.has(type);
}
