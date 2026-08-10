/**
 * sdk-types-local.ts — localized SDK type shapes for the native engine bridge.
 *
 * G-1 (2026-08-10) consumption rewrite: the Rust engine bridge
 * (`native-session.ts` / `native-server-client.ts`) used to import these
 * types from `@moonshot-ai/kimi-code-sdk` purely as type annotations for the
 * wire→SDK translation helpers and the `TuiSession` facade. They are copied
 * here as a local, dependency-free mirror (shapes taken from
 * `node-sdk/src/{types.ts,events.ts,legacy/wire-types.ts,legacy/rpc-types.ts,
 * legacy/plugin/types.ts}`, `kosong/src/{message.ts,capability.ts,provider.ts}`
 * and `protocol/src/display.ts`).
 *
 * Only the members the bridge consumes are mirrored. Two shapes are loosened
 * deliberately to stay supertypes of the SDK originals (host↔adapter signatures
 * still mention the SDK types, so the local shapes must accept them):
 * - `Event` — narrowed to the fields every engine event carries
 *   (`type`/`agentId`/`sessionId`); the SDK's 20-member event union is a
 *   subtype of this.
 * - `ToolInputDisplay` — narrowed to `kind`; every SDK display branch carries
 *   a `kind` literal.
 *
 * Keep in sync with the SDK originals when the bridge consumes new members.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

// ── LLM message shapes (kosong/src/message.ts mirror) ─────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string;
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string | undefined };
}

export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

export interface ToolCall {
  type: 'function';
  id: string;
  name: string;
  arguments: string | null;
  extras?: Record<string, unknown>;
  _streamIndex?: number | string;
}

export interface Message {
  readonly role: Role;
  readonly name?: string;
  readonly content: ContentPart[];
  readonly toolCalls: ToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
}

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;
export type PromptInput = readonly PromptPart[];

export type ThinkingEffort = 'off' | 'on' | (string & {});

/** Model capability flags (kosong/src/capability.ts mirror). */
export interface ModelCapability {
  readonly image_in: boolean;
  readonly video_in: boolean;
  readonly audio_in: boolean;
  readonly thinking: boolean;
  readonly tool_use: boolean;
  readonly max_context_tokens: number;
  readonly max_input_tokens?: number;
  readonly dynamically_loaded_tools?: boolean;
}

// ── Context messages + origins (node-sdk legacy/wire-types.ts mirror) ─────

export interface UserPromptOrigin {
  readonly kind: 'user';
}

export interface SkillActivationOrigin {
  readonly kind: 'skill_activation';
  readonly activationId: string;
  readonly skillName: string;
  readonly skillArgs?: string | undefined;
  readonly trigger: 'user-slash' | 'model-tool' | 'nested-skill';
  readonly skillType?: string | undefined;
  readonly skillPath?: string | undefined;
  readonly skillSource?: string | undefined;
}

export interface PluginCommandOrigin {
  readonly kind: 'plugin_command';
  readonly activationId: string;
  readonly pluginId: string;
  readonly commandName: string;
  readonly commandArgs?: string | undefined;
  readonly trigger: 'user-slash';
}

export interface InjectionOrigin {
  readonly kind: 'injection';
  readonly variant: string;
}

export interface ShellCommandOrigin {
  readonly kind: 'shell_command';
  readonly phase: 'input' | 'output';
  readonly isError?: boolean;
}

export interface CompactionSummaryOrigin {
  readonly kind: 'compaction_summary';
}

export interface SystemTriggerOrigin {
  readonly kind: 'system_trigger';
  readonly name: string;
}

export interface BackgroundTaskOrigin {
  readonly kind: 'background_task';
  readonly taskId: string;
  readonly status: BackgroundTaskStatus;
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
  | BackgroundTaskOrigin
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export type ContextMessage = Message & {
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly toolCallDisplays?: Record<string, unknown>;
  readonly note?: string;
};

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}

// ── Permission / approval ────────────────────────────────────────────────

export type PermissionMode = 'yolo' | 'manual' | 'auto';

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';
export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface PermissionData {
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';
export type ApprovalScope = 'session';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: ApprovalScope | undefined;
  readonly feedback?: string | undefined;
  readonly selectedLabel?: string | undefined;
}

/** Mirror of protocol's `ToolInputDisplay` union: the `generic` branch is
 *  what the bridge constructs; the loose `{ kind: string }` member accepts
 *  every other SDK display branch (each carries a `kind` literal). */
export type ToolInputDisplay =
  | { readonly kind: 'generic'; readonly summary: string; readonly detail?: unknown }
  | { readonly kind: string };

export interface ApprovalRequest {
  readonly turnId?: number | undefined;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export type MaybePromise<T> = T | Promise<T>;
export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

// ── Goals ─────────────────────────────────────────────────────────────────

export type GoalStatus =
  | 'active'
  | 'paused'
  | 'blocked'
  | 'complete'
  | 'budget_limited'
  | 'usage_limited';

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
  readonly blockedStreak?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GoalToolResult {
  readonly goal: GoalSnapshot | null;
}

export interface GoalChangeStats {
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
}

export type GoalChangeKind = 'created' | 'lifecycle' | 'completion';

export interface GoalChange {
  readonly kind: GoalChangeKind;
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly stats?: GoalChangeStats;
  readonly actor?: GoalActor;
}

export interface CompactionResult {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
}

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export type AgentReplayRecordPayload =
  | { readonly type: 'message'; readonly message: ContextMessage }
  | {
      readonly type: 'compaction';
      readonly result?: CompactionResult | 'cancelled';
      readonly instruction?: string;
    }
  | {
      readonly type: 'goal_updated';
      readonly snapshot: GoalSnapshot;
      readonly change: GoalChange | { readonly kind: 'created' };
    }
  | { readonly type: 'plan_updated'; readonly enabled: boolean }
  | { readonly type: 'config_updated'; readonly config: AgentConfigUpdateData }
  | { readonly type: 'permission_updated'; readonly mode: PermissionMode }
  | {
      readonly type: 'approval_result';
      readonly record: PermissionApprovalResultRecord;
    };

export type AgentReplayRecord = { readonly time: number } & AgentReplayRecordPayload;

// ── Resume / agent state ─────────────────────────────────────────────────

export type AgentType = 'main' | 'sub' | 'independent';

export interface AgentConfigData {
  readonly cwd: string;
  readonly modelAlias?: string;
  readonly modelCapabilities: ModelCapability;
  readonly thinkingEffort: string;
  readonly systemPrompt: string;
}

export type AgentConfigUpdateData = Partial<{
  cwd: string;
  modelAlias: string;
  profileName: string;
  thinkingEffort: string;
  systemPrompt: string;
}>;

export interface ResumedAgentState {
  readonly type: AgentType;
  readonly config: AgentConfigData;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: unknown;
  readonly swarmMode?: boolean | undefined;
  readonly usage: unknown;
  readonly tools: readonly ToolInfo[];
  readonly background: readonly BackgroundTaskInfo[];
}

export interface AgentMeta {
  readonly [key: string]: unknown;
}

export interface SessionMeta {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly isCustomTitle: boolean;
  readonly lastPrompt?: string;
  readonly forkedFrom?: string;
  readonly workDir?: string;
  readonly additionalDirs?: string[];
  readonly agents: Record<string, AgentMeta>;
  readonly custom: Record<string, unknown>;
}

export type ResumedSessionState = Pick<ResumeSessionResult, 'sessionMetadata' | 'agents' | 'warning'>;

export interface ResumedSessionSummary extends SessionSummary, ResumedSessionState {}

// ── Session surface ──────────────────────────────────────────────────────

export interface SessionSummary {
  readonly id: string;
  readonly title?: string | undefined;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived?: boolean | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface ResumeSessionResult extends SessionSummary {
  readonly sessionMetadata: SessionMeta;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string | undefined;
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
  readonly usage?: SessionUsage;
}

export interface PlanInfo {
  readonly id: string;
  readonly content: string;
  readonly path: string;
}

export type SessionPlan = PlanInfo | null;

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface CreateGoalInput {
  readonly objective: string;
  readonly replace?: boolean;
}

export interface CompactOptions {
  readonly instruction?: string | undefined;
}

export interface ReloadSessionOptions {
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface AddAdditionalDirOptions {
  readonly persist: boolean;
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

// ── Cron / MCP / skills / tools / background tasks ───────────────────────

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

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

export interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly source: 'builtin' | 'user' | 'extra' | 'project';
  readonly type?: string | undefined;
  readonly disableModelInvocation?: boolean | undefined;
  readonly isSubSkill?: boolean | undefined;
}

export type ToolSource = 'builtin' | 'user' | 'mcp';

export interface ToolInfo {
  readonly name: string;
  readonly description: string;
  readonly active: boolean;
  readonly source: ToolSource;
}

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface BackgroundTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: BackgroundTaskStatus;
  readonly detached?: boolean;
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

// ── Events ────────────────────────────────────────────────────────────────
// Mirror of the SDK `Event` union (`protocol/src/events.ts`): `AgentEvent &
// { agentId; sessionId }`, the snake_case host/engine event stream the
// adapter stamps with routing fields. The TUI's `TuiSession.onEvent` still
// types listeners against the SDK union, so the local union must stay
// bidirectionally compatible member-for-member (TS checks both directions on
// nested function parameters). Deep dependency payloads the bridge never
// touches (session/workspace/config records, agent phase) are loosened to
// `Record<string, unknown>` / `{ kind: string }`; the SDK payload types are
// structurally assignable into them.

/** Local mirror of `UsageStatus` (protocol events.ts; TokenUsage above). */
export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
}

/** Loosened mirror of the SDK `AgentPhase` union (every phase carries a
 *  `kind` discriminator). */
export type AgentPhase = { readonly kind: string };

/** `sessionPendingInteractionSchema` enum (protocol session.ts). */
export type SessionPendingInteraction = 'none' | 'approval' | 'question';

/** Loosened mirror of `KimiErrorPayload` (protocol events.ts): `code` is the
 *  SDK `KimiErrorCode` literal union, a subtype of `string`. */
export interface KimiErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;
  readonly cause?: KimiErrorPayload;
}

export interface ErrorEvent extends KimiErrorPayload {
  readonly type: 'error';
}

export interface WarningEvent {
  readonly type: 'warning';
  readonly message: string;
  readonly code?: string;
}

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

export interface SessionCreatedEvent {
  readonly type: 'event.session.created';
  readonly session: Record<string, unknown>;
}

export interface WorkspaceCreatedEvent {
  readonly type: 'event.workspace.created';
  readonly workspace: Record<string, unknown>;
}

export interface WorkspaceUpdatedEvent {
  readonly type: 'event.workspace.updated';
  readonly workspace: Record<string, unknown>;
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
  readonly previous_status:
    | 'idle'
    | 'running'
    | 'awaiting_approval'
    | 'awaiting_question'
    | 'aborted';
  readonly current_prompt_id?: string;
}

export interface ConfigChangedEvent {
  readonly type: 'event.config.changed';
  readonly changedFields: string[];
  readonly config: Record<string, unknown>;
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

/** `snapshot` is the SDK `GoalSnapshot` (engine serde camelCase). */
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

// ── Host-synthesized events (snake_case) ──────────────────────────────────

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

/** Minimal `Session` surface used to derive `SessionWarning` (the SDK's
 *  `getSessionWarnings` resolves through a `Promise<any>` rpc). */
export interface Session {
  getSessionWarnings(): Promise<unknown[]>;
}

// ── Plugins (node-sdk legacy/plugin/types.ts mirror) ─────────────────────

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly message: string;
}

export type PluginSource = 'local-path' | 'zip-url' | 'github';
export type PluginState = 'ok' | 'error';

export interface PluginMcpServerInfo {
  readonly name: string;
  readonly runtimeName: string;
  readonly enabled: boolean;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
}

export interface PluginCommandDef {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly path: string;
}

export interface PluginSummary {
  readonly id: string;
  readonly displayName: string;
  readonly version?: string;
  readonly enabled: boolean;
  readonly state: PluginState;
  readonly skillCount: number;
  readonly mcpServerCount: number;
  readonly enabledMcpServerCount: number;
  readonly hookCount: number;
  readonly commandCount: number;
  readonly hasErrors: boolean;
  readonly source: PluginSource;
  readonly originalSource?: string;
  readonly github?: PluginGithubMetadata;
}

export interface PluginGithubRef {
  readonly kind: 'branch' | 'tag' | 'sha';
  readonly value: string;
}

export interface PluginGithubMetadata {
  readonly owner: string;
  readonly repo: string;
  readonly ref: PluginGithubRef;
  readonly installedSha?: string;
}

export interface PluginInfo extends PluginSummary {
  readonly root: string;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly manifestPath?: string;
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}
