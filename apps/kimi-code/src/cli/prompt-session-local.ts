/**
 * prompt-session-local.ts — localized type surface for the print-mode
 * harness/session bridge (G-1 consumption rewrite).
 *
 * `prompt-session.ts` (and its consumers) previously imported these symbols
 * from `@moonshot-ai/kimi-code-sdk`. The shapes below mirror the SDK/protocol
 * definitions the print-mode driver actually reads — the full engine `Event`
 * union and its payloads, session/status/goal/cron summaries, and the
 * reverse-RPC handler signatures. `Event` is a structural mirror of the
 * protocol `AgentEvent & { agentId; sessionId }` union (member-for-member),
 * so SDK-typed hosts and the local surface stay mutually assignable. This
 * module is type-only and carries no runtime logic.
 */

export type Unsubscribe = () => void;

export type PermissionMode = 'yolo' | 'manual' | 'auto';

export type TelemetryPropertyValue = boolean | number | string | undefined | null;

export type TelemetryProperties = Readonly<Record<string, TelemetryPropertyValue>>;

export interface CreateGoalInput {
  readonly objective: string;
  readonly replace?: boolean;
}

/** A text/image/video prompt part (relaxed shape; the driver only passes plain strings). */
export interface PromptPart {
  readonly type: 'text' | 'image_url' | 'video_url';
  readonly text?: string | undefined;
}

export type PromptInput = readonly PromptPart[];

export interface CreateSessionOptions {
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly additionalDirs?: readonly string[];
  /** Print-mode (`kimi -p`) only: hold the turn open until background agent
   *  tasks drain before the run exits. */
  readonly drainAgentTasksOnStop?: boolean;
}

export interface ResumeSessionInput {
  readonly id: string;
  readonly additionalDirs?: readonly string[];
}

export interface ListSessionsOptions {
  readonly workDir?: string;
  readonly sessionId?: string;
}

export interface TokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export interface SessionUsage {
  readonly byModel?: Record<string, TokenUsage> | undefined;
  readonly currentTurn?: TokenUsage | undefined;
  readonly total?: TokenUsage | undefined;
}

export interface SessionStatus {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode?: boolean | undefined;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: SessionUsage | undefined;
}

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface ConfigDiagnostics {
  readonly warnings: readonly string[];
}

/** Minimal config view the print driver reads (`defaultModel`, `telemetry`). */
export interface KimiConfig {
  readonly defaultModel?: string | undefined;
  readonly telemetry?: boolean | undefined;
}

/** Access-token surface the telemetry bootstrap reads off the harness auth. */
export interface KimiAuthFacade {
  getCachedAccessToken(providerName?: string, oauthRef?: unknown): Promise<string | undefined>;
}

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: unknown;
}

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session' | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
}

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export interface QuestionOption {
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly question: string;
  readonly header?: string;
  readonly body?: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect?: boolean;
  readonly otherLabel?: string;
  readonly otherDescription?: string;
}

export interface QuestionRequest {
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';

/**
 * Flattened answers keyed by question text; values are the chosen option
 * label(s) (comma-joined for multi-select) or free-form "Other" text.
 * `true` marks a question as answered without echoing a concrete value.
 */
export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod | undefined;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'
  | 'budget_limited'
  | 'usage_limited';

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
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly terminalReason?: string;
}

export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

export interface CronTaskSnapshot {
  readonly id: string;
  readonly cron: string;
  readonly recurring: boolean;
  readonly createdAt: number;
  readonly lastFiredAt: number | undefined;
  readonly nextFireAt: number | null;
}

export interface GetCronTasksResult {
  readonly tasks: readonly CronTaskSnapshot[];
}

// ── `Event` union (member-for-member mirror of the protocol `AgentEvent &
//    { agentId; sessionId }` union, which the SDK re-exports verbatim) ─────

/**
 * Mirror of the protocol `KimiErrorCode` literal union — the `error` event
 * carries it verbatim, and `Event` must stay structurally assignable to the
 * SDK/protocol union for SDK-typed hosts to satisfy `PromptSession`.
 */
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
  | 'session.tool_handler_error'
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
  readonly usage?: SessionUsage;
  readonly phase?: AgentPhase;
}

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_opened_at: string;
  readonly session_count: number;
}

export type SessionPendingInteraction = 'none' | 'approval' | 'question';

export interface SessionMetadata {
  readonly cwd: string;
  readonly [key: string]: unknown;
}

export interface SessionAgentConfig {
  readonly model: string;
  readonly system_prompt?: string;
  readonly tools?: readonly string[];
  readonly mcp_servers?: readonly string[];
  readonly thinking?: unknown;
  readonly permission_mode?: unknown;
  readonly plan_mode?: boolean;
  readonly swarm_mode?: boolean;
  readonly goal_objective?: string;
  readonly goal_control?: 'pause' | 'resume' | 'cancel';
}

/** Protocol `sessionUsageSchema` wire shape (snake_case; distinct from the
 *  camelCase `SessionUsage` above). */
export interface SessionUsageWire {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_creation_tokens: number;
  readonly total_cost_usd: number;
  readonly context_tokens: number;
  readonly context_limit: number;
  readonly turn_count: number;
}

export interface SessionPermissionRule {
  readonly id: string;
  readonly tool_name: string;
  readonly matcher?: {
    readonly kind: 'command_prefix' | 'path_glob' | 'exact_input' | 'always';
    readonly value?: string;
  };
  readonly decision: 'approved';
  readonly created_at: string;
  readonly created_by: 'user' | 'agent';
}

export interface Session {
  readonly id: string;
  readonly workspace_id: string;
  readonly title: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly busy: boolean;
  readonly main_turn_active?: boolean;
  readonly pending_interaction?: SessionPendingInteraction;
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  readonly archived?: boolean;
  readonly current_prompt_id?: string;
  readonly last_prompt?: string;
  readonly metadata: SessionMetadata;
  readonly agent_config: SessionAgentConfig;
  readonly usage: SessionUsageWire;
  readonly permission_rules: readonly SessionPermissionRule[];
  readonly message_count: number;
  readonly last_seq: number;
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
  readonly main_turn_active?: boolean;
  readonly pending_interaction?: SessionPendingInteraction;
  readonly last_turn_reason?: 'completed' | 'cancelled' | 'failed';
}

export interface SessionStatusChangedEvent {
  readonly type: 'event.session.status_changed';
  readonly status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly previous_status: 'idle' | 'running' | 'awaiting_approval' | 'awaiting_question' | 'aborted';
  readonly current_prompt_id?: string;
}

export interface ProviderConfigResponse {
  readonly type: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly has_api_key: boolean;
}

export interface ConfigResponse {
  readonly providers: Readonly<Record<string, ProviderConfigResponse>>;
  readonly default_provider?: string;
  readonly default_model?: string;
  readonly models?: Readonly<Record<string, unknown>>;
  readonly thinking?: unknown;
  readonly plan_mode?: boolean;
  readonly yolo?: boolean;
  readonly default_permission_mode?: string;
  readonly default_plan_mode?: boolean;
  readonly permission?: unknown;
  readonly hooks?: readonly unknown[];
  readonly services?: unknown;
  readonly merge_all_available_skills?: boolean;
  readonly extra_skill_dirs?: readonly string[];
  readonly loop_control?: unknown;
  readonly background?: unknown;
  readonly experimental?: Readonly<Record<string, boolean>>;
  readonly telemetry?: boolean;
  readonly raw?: Readonly<Record<string, unknown>>;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: ConfigResponse;
}

export interface ProviderRefreshChange {
  readonly provider_id: string;
  readonly provider_name: string;
  readonly added: number;
  readonly removed: number;
}

export interface ProviderRefreshFailure {
  readonly provider: string;
  readonly reason: string;
}

export interface ModelCatalogChangedEvent {
  readonly type: 'event.model_catalog.changed';
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
}

// ── Rust engine events (protocol-toward-engine, snake_case) ───────────────

export interface EngineTurnStartedEvent {
  readonly type: 'session.turn.started';
  readonly turn_id: number;
}

export interface EngineTurnEndedEvent {
  readonly type: 'session.turn.ended';
  readonly turn_id: number;
  readonly stop_reason: string;
  readonly steps: number;
}

export interface EngineLlmStepBeginEvent {
  readonly type: 'llm.step.begin';
  readonly model: string;
}

export interface EngineLlmDeltaEvent {
  readonly type: 'llm.delta';
  readonly part:
    | { readonly type: 'text'; readonly text?: string }
    | { readonly type: 'think'; readonly think?: string }
    | {
        readonly type: 'tool_call';
        readonly id?: string;
        readonly name?: string;
        readonly args?: string;
      };
}

export interface EngineLlmStepEndEvent {
  readonly type: 'llm.step.end';
  readonly content: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export interface EngineToolStartedEvent {
  readonly type: 'session.tool.started';
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly arguments?: unknown;
}

export interface EngineToolSettledEvent {
  readonly type: 'session.tool.settled';
  readonly tool_call_id: string;
  readonly tool_name: string;
  readonly content: string;
  readonly is_error: boolean;
}

/** `snapshot` is emitted by the engine as camelCase `GoalSnapshot` (serde
 *  `rename_all = "camelCase"` on the Rust side) — the goal data contract is
 *  the SDK's `GoalSnapshot`, only the event envelope follows the engine. */
export interface EngineGoalUpdatedEvent {
  readonly type: 'session.goal.updated';
  readonly status: string;
  readonly snapshot: GoalSnapshot | null;
}

export interface EngineTaskStartedEvent {
  readonly type: 'session.task.started';
  readonly task_id: string;
  readonly description: string;
  readonly kind: string;
  readonly started_at_ms: number;
}

export interface EngineTaskTerminatedEvent {
  readonly type: 'session.task.terminated';
  readonly task_id: string;
  readonly status: string;
  readonly description: string;
}

export interface EngineUsageUpdatedEvent {
  readonly type: 'session.usage.updated';
  readonly turn_id: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
}

export interface EngineHookResultEvent {
  readonly type: 'session.hook.result';
  readonly hook_event: string;
  readonly content: string;
  readonly blocked: boolean;
}

export interface EngineCompactionStartedEvent {
  readonly type: 'session.compaction.started';
  readonly source: string;
  readonly tokens_before: number;
}

export interface EngineShellOutputEvent {
  readonly type: 'session.shell.output';
  readonly command_id: string;
  readonly chunk: string;
}

// ── Host-synthesized events (snake_case) ─────────────────────────────────

export interface HostSessionMetaUpdatedEvent {
  readonly type: 'session.meta.updated';
  readonly title?: string;
  readonly patch?: Record<string, unknown>;
}

export interface HostConfigUpdateEvent {
  readonly type: 'config.update';
  readonly model_alias?: string;
  readonly thinking_effort?: string;
  readonly permission_mode?: string;
}

export interface HostPermissionSetModeEvent {
  readonly type: 'permission.set_mode';
  readonly mode: string;
}

export interface HostTurnSteerEvent {
  readonly type: 'turn.steer';
  readonly input: unknown;
}

export interface HostSessionClosedEvent {
  readonly type: 'session.closed';
}

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

export type AgentEvent =
  | ErrorEvent
  | WarningEvent
  | AgentStatusUpdatedEvent
  | SessionCreatedEvent
  | WorkspaceCreatedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceDeletedEvent
  | SessionWorkChangedEvent
  | SessionStatusChangedEvent
  | ConfigChangedEvent
  | ModelCatalogChangedEvent
  | EngineTurnStartedEvent
  | EngineTurnEndedEvent
  | EngineLlmStepBeginEvent
  | EngineLlmDeltaEvent
  | EngineLlmStepEndEvent
  | EngineToolStartedEvent
  | EngineToolSettledEvent
  | EngineGoalUpdatedEvent
  | EngineTaskStartedEvent
  | EngineTaskTerminatedEvent
  | EngineUsageUpdatedEvent
  | EngineHookResultEvent
  | EngineCompactionStartedEvent
  | EngineShellOutputEvent
  | HostSessionMetaUpdatedEvent
  | HostConfigUpdateEvent
  | HostPermissionSetModeEvent
  | HostTurnSteerEvent
  | HostSessionClosedEvent;

export type Event = AgentEvent & { agentId: string; sessionId: string };
