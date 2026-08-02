/**
 * Local copies of the v2 service contracts and DI decorators from the retired
 * engine package `@moonshot-ai/agent-core-v2`.
 *
 * Sources (each section header names the v2 file):
 *   packages/agent-core-v2/src/app/{auth,config,flag,sessionIndex,
 *     sessionLifecycle,workspace}/*
 *   packages/agent-core-v2/src/agent/{activityView,contextSize,goal,mcp,
 *     permissionMode,permissionRules,plan,profile,rpc,swarm,task,
 *     toolRegistry,usage}/*
 *   packages/agent-core-v2/src/kosong/{model,provider}/*
 *   packages/agent-core-v2/src/session/{approval,interaction,question,
 *     sessionInit,sessionMetadata,workspaceContext}/*
 *
 * Why this file exists: the app only consumes service decorators as *wire
 * identifiers* (`String(id)` → channel name) and as the type parameter that
 * types the client's proxies. The decorator NAMES below are the wire contract
 * — they must match the v2 names exactly, because kap-server's channel
 * registry is keyed by them. Everything else (the DI container, scopes,
 * bootstrap) is unused here and was not ported.
 *
 * The interface bodies are pruned to the members kimi-inspect actually calls
 * through a typed proxy; members whose signatures pull in v2-internal
 * machinery (Event streams, hooks, scope handles, requester/agent internals)
 * were omitted, and a few result types were widened to `unknown` where the
 * panel renders the wire value as JSON anyway. Widened/omitted spots carry a
 * `// pruned:` note. Do not change the decorator names.
 */

import { createDecorator, type ServiceIdentifier } from './di';
import type { InspectionSource, TokenUsage } from './contracts';

// ---------------------------------------------------------------------------
// app/sessionLifecycle/sessionLifecycle.ts
// ---------------------------------------------------------------------------

export interface ISessionLifecycleService {
  readonly _serviceBrand: undefined;

  /** pruned: resume only — the rest (create/get/list/close/archive/restore/
   * fork/createChild, hook slots, Event streams) is unused by this app.
   * Result widened from `Promise<ISessionScopeHandle | undefined>`. */
  resume(sessionId: string): Promise<unknown>;
}

export const ISessionLifecycleService: ServiceIdentifier<ISessionLifecycleService> =
  createDecorator<ISessionLifecycleService>('sessionLifecycleService');

// ---------------------------------------------------------------------------
// app/config/config.ts
// ---------------------------------------------------------------------------

export interface ConfigDiagnostic {
  readonly domain?: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

/** pruned: get/getAll/reload/diagnostics only; `get` and `getAll` are the
 * typed call sites, `reload`/`diagnostics` feed the ConfigService panel. */
export interface IConfigService {
  readonly _serviceBrand: undefined;

  get<T = unknown>(domain: string): T;
  getAll(): Record<string, unknown>;
  reload(): Promise<void>;
  diagnostics(): readonly ConfigDiagnostic[];
}

export const IConfigService: ServiceIdentifier<IConfigService> =
  createDecorator<IConfigService>('configService');

// ---------------------------------------------------------------------------
// app/flag/flag.ts
// ---------------------------------------------------------------------------

/** pruned: `FlagId`/`FlagSurface` widened from the v2 `flagRegistry` types to
 * `string` (the FlagService panel renders these as JSON). */
export interface ExperimentalFeatureState {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly surface: string;
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly source: 'master-env' | 'env' | 'config' | 'default';
  readonly configValue?: boolean;
}

export interface IFlagService {
  readonly _serviceBrand: undefined;

  explainAll(): readonly ExperimentalFeatureState[];
}

export const IFlagService: ServiceIdentifier<IFlagService> =
  createDecorator<IFlagService>('flagService');

// ---------------------------------------------------------------------------
// app/auth/auth.ts
// ---------------------------------------------------------------------------

export interface AuthStatus {
  readonly loggedIn: boolean;
  readonly provider?: string;
}

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;

  summarize(): Promise<readonly AuthStatus[]>;
  ensureReady(modelOverride?: string): Promise<void>;
}

export const IAuthSummaryService: ServiceIdentifier<IAuthSummaryService> =
  createDecorator<IAuthSummaryService>('authSummaryService');

// ---------------------------------------------------------------------------
// app/sessionIndex/sessionIndex.ts
// ---------------------------------------------------------------------------

/** Copied from `persistence/interface/queryStore.ts` (same source package). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export interface SessionSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly custom?: Record<string, unknown>;
}

export interface SessionListQuery {
  readonly workspaceIds?: readonly string[];
  readonly sessionId?: string;
  readonly includeArchived?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
  readonly childOf?: string;
}

export interface ISessionIndex {
  readonly _serviceBrand: undefined;

  list(query: SessionListQuery): Promise<Page<SessionSummary>>;
  get(id: string): Promise<SessionSummary | undefined>;
  countActive(workspaceIds: readonly string[]): Promise<number>;
}

export const ISessionIndex: ServiceIdentifier<ISessionIndex> =
  createDecorator<ISessionIndex>('sessionIndex');

// ---------------------------------------------------------------------------
// app/workspace/workspace.ts
// ---------------------------------------------------------------------------

export interface Workspace {
  readonly id: string;
  readonly root: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastOpenedAt: number;
}

export interface WorkspaceUpdate {
  readonly name?: string;
}

export interface IWorkspaceService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly Workspace[]>;
  get(id: string): Promise<Workspace | undefined>;
  createOrTouch(root: string, name?: string): Promise<Workspace>;
  update(id: string, patch: WorkspaceUpdate): Promise<Workspace | undefined>;
  delete(id: string): Promise<void>;
}

export const IWorkspaceService: ServiceIdentifier<IWorkspaceService> =
  createDecorator<IWorkspaceService>('workspaceService');

// ---------------------------------------------------------------------------
// session/sessionMetadata/sessionMetadata.ts
// ---------------------------------------------------------------------------

export interface AgentMeta {
  /** Absolute standard path retained for older v1 readers. Current readers
   * derive the agent directory from the session scope and ignore this field. */
  readonly homedir?: string;
  readonly type?: 'main' | 'sub' | 'independent';
  readonly parentAgentId?: string | null;
  readonly forkedFrom?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly swarmItem?: string;
}

export interface SessionMeta {
  readonly id: string;
  readonly version?: number;
  readonly title?: string;
  readonly isCustomTitle?: boolean;
  readonly lastPrompt?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly cwd?: string;
  readonly forkedFrom?: string;
  readonly agents?: Readonly<Record<string, AgentMeta>>;
  readonly custom?: Record<string, unknown>;
}

export type SessionMetaPatch = Partial<Omit<SessionMeta, 'id' | 'createdAt'>>;

/** pruned: `onDidChangeMetadata` Event stream omitted. */
export interface ISessionMetadata {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;
  read(): Promise<SessionMeta>;
  update(patch: SessionMetaPatch): Promise<void>;
  setTitle(title: string): Promise<void>;
  setArchived(archived: boolean): Promise<void>;
  registerAgent(agentId: string, meta: AgentMeta): Promise<void>;
}

export const ISessionMetadata: ServiceIdentifier<ISessionMetadata> =
  createDecorator<ISessionMetadata>('sessionMetadata');

// ---------------------------------------------------------------------------
// session/approval/approval.ts
// ---------------------------------------------------------------------------

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

/** pruned: `request`/`enqueue` omitted (`ApprovalRequest.display` types the
 * v2 `ToolInputDisplay`). */
export interface ISessionApprovalService {
  readonly _serviceBrand: undefined;

  decide(id: string, response: ApprovalResponse): void;
  listPending(): readonly unknown[];
}

export const ISessionApprovalService: ServiceIdentifier<ISessionApprovalService> =
  createDecorator<ISessionApprovalService>('sessionApprovalService');

// ---------------------------------------------------------------------------
// session/question/question.ts
// ---------------------------------------------------------------------------

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

export type QuestionAnswerMethod = 'enter' | 'space' | 'number_key';

export type QuestionAnswers = Record<string, string | true>;

export interface QuestionResponse {
  readonly answers: QuestionAnswers;
  readonly method?: QuestionAnswerMethod;
}

export type QuestionResult = null | QuestionAnswers | QuestionResponse;

export interface QuestionRequest {
  readonly id?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly questions: readonly QuestionItem[];
}

export interface ISessionQuestionService {
  readonly _serviceBrand: undefined;

  request(
    req: QuestionRequest,
    options?: { signal?: AbortSignal; agentId?: string },
  ): Promise<QuestionResult>;
  enqueue(req: QuestionRequest): QuestionRequest & { readonly id: string };
  answer(id: string, result: QuestionResult): void;
  dismiss(id: string): void;
  listPending(): readonly QuestionRequest[];
}

export const ISessionQuestionService: ServiceIdentifier<ISessionQuestionService> =
  createDecorator<ISessionQuestionService>('sessionQuestionService');

// ---------------------------------------------------------------------------
// session/interaction/interaction.ts
// ---------------------------------------------------------------------------

export type InteractionKind = 'approval' | 'question' | 'user_tool';

export interface InteractionOrigin {
  readonly agentId?: string;
  readonly turnId?: number;
}

export interface InteractionRequest<TPayload = unknown> {
  readonly id?: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin?: InteractionOrigin;
}

export interface Interaction<TPayload = unknown> {
  readonly id: string;
  readonly kind: InteractionKind;
  readonly payload: TPayload;
  readonly origin: InteractionOrigin;
  readonly createdAt: number;
}

export interface InteractionResolution {
  readonly id: string;
  readonly response: unknown;
}

/** pruned: `onDidChangePending`/`onDidResolve` Event streams omitted. */
export interface ISessionInteractionService {
  readonly _serviceBrand: undefined;

  request<TPayload, TResponse>(req: InteractionRequest<TPayload>): Promise<TResponse>;
  enqueue<TPayload>(req: InteractionRequest<TPayload>): Interaction;
  respond(id: string, response: unknown): void;
  listPending(kind?: InteractionKind): readonly Interaction[];
  isRecentlyResolved(id: string): boolean;
  cancelPendingForTurn(turnId: number): void;
}

export const ISessionInteractionService: ServiceIdentifier<ISessionInteractionService> =
  createDecorator<ISessionInteractionService>('sessionInteractionService');

// ---------------------------------------------------------------------------
// session/sessionInit/sessionInit.ts
// ---------------------------------------------------------------------------

export interface ISessionInitService {
  readonly _serviceBrand: undefined;

  generateAgentsMd(): Promise<void>;
  cancelInit(): void;
}

export const ISessionInitService: ServiceIdentifier<ISessionInitService> =
  createDecorator<ISessionInitService>('sessionInitService');

// ---------------------------------------------------------------------------
// session/workspaceContext/workspaceContext.ts
// ---------------------------------------------------------------------------

export type PathAccessOperation = 'read' | 'write' | 'execute';

export interface ISessionWorkspaceContext {
  readonly _serviceBrand: undefined;

  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  setWorkDir(workDir: string): void;
  setAdditionalDirs(dirs: readonly string[]): void;
  resolve(rel: string): string;
  isWithin(absPath: string): boolean;
  assertAllowed(absPath: string, op: PathAccessOperation): string;
  addAdditionalDir(dir: string): void;
  removeAdditionalDir(dir: string): void;
}

export const ISessionWorkspaceContext: ServiceIdentifier<ISessionWorkspaceContext> =
  createDecorator<ISessionWorkspaceContext>('sessionWorkspaceContext');

// ---------------------------------------------------------------------------
// agent/activityView/activityView.ts
// ---------------------------------------------------------------------------

/** From `agent/loop/turnEvents.ts` (same source package). */
export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export type TurnPhase = 'running' | 'streaming' | 'tool_call' | 'retrying';

export interface ApprovalRef {
  readonly approvalId: string;
  readonly toolCallId?: string;
  readonly since: number;
}

export interface ToolCallRef {
  readonly toolCallId: string;
  readonly name: string;
  readonly since: number;
}

export interface ActivityRetryState {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName?: string;
  readonly statusCode?: number;
}

/** pruned: `origin` widened from the v2 `PromptOrigin` union (12 members). */
export interface ActivityTurnState {
  readonly turnId: number;
  readonly origin: unknown;
  readonly phase: TurnPhase;
  readonly stream?: 'assistant' | 'thinking' | 'tool_call';
  readonly step: number;
  readonly ending: boolean;
  readonly endingReason?: 'aborted' | 'max_steps' | 'error';
  readonly retry?: ActivityRetryState;
  readonly pendingApprovals: readonly ApprovalRef[];
  readonly activeToolCalls: readonly ToolCallRef[];
  readonly since: number;
}

export interface ActivityLastTurnState {
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly durationMs?: number;
  readonly at: number;
}

export interface BackgroundRef {
  readonly kind: string;
  readonly id: string;
  readonly since: number;
}

export type ActivityViewLifecycle = 'ready' | 'disposed';

/** The agent's folded activity snapshot — the payload of `agent.activity.updated`. */
export interface AgentActivityState {
  readonly lifecycle: ActivityViewLifecycle;
  readonly turn?: ActivityTurnState;
  readonly lastTurn?: ActivityLastTurnState;
  readonly background: readonly BackgroundRef[];
}

export interface IAgentActivityView {
  readonly _serviceBrand: undefined;

  state(): AgentActivityState;
}

export const IAgentActivityView: ServiceIdentifier<IAgentActivityView> =
  createDecorator<IAgentActivityView>('agentActivityView');

// ---------------------------------------------------------------------------
// agent/contextSize/contextSize.ts
// ---------------------------------------------------------------------------

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

/** pruned: `measured` omitted (types the v2 `Message` contract). */
export interface IAgentContextSizeService {
  readonly _serviceBrand: undefined;

  get(start?: number, end?: number): ContextSize;
}

export const IAgentContextSizeService: ServiceIdentifier<IAgentContextSizeService> =
  createDecorator<IAgentContextSizeService>('agentContextSizeService');

// ---------------------------------------------------------------------------
// agent/goal/goal.ts
// ---------------------------------------------------------------------------

export interface GoalReasonInput {
  readonly reason?: string;
}

export interface ResumeGoalInput extends GoalReasonInput {
  readonly continueIfPaused?: boolean;
  readonly continueIfBlocked?: boolean;
}

/** pruned: results widened from the v2 `GoalSnapshot`/`GoalToolResult`. */
export interface IAgentGoalService {
  readonly _serviceBrand: undefined;

  getGoal(): unknown;
  pauseGoal(input?: GoalReasonInput): Promise<unknown>;
  resumeGoal(input?: ResumeGoalInput): Promise<unknown>;
  cancelGoal(input?: GoalReasonInput): Promise<unknown>;
}

export const IAgentGoalService = createDecorator<IAgentGoalService>('agentGoalService');

// ---------------------------------------------------------------------------
// agent/mcp/mcp.ts
// ---------------------------------------------------------------------------

/** pruned: `list` widened from `readonly McpServerEntry[]`; only `list` /
 * `reconnect` are used by the AgentMcpService panel. */
export interface IAgentMcpService {
  readonly _serviceBrand: undefined;

  list(): readonly unknown[];
  reconnect(name: string, signal?: AbortSignal): Promise<void>;
}

export const IAgentMcpService = createDecorator<IAgentMcpService>('agentMcpService');

// ---------------------------------------------------------------------------
// agent/permissionMode/permissionMode.ts
// ---------------------------------------------------------------------------

/** From `agent/permissionPolicy/types.ts` (same source package). */
export type PermissionMode = 'manual' | 'yolo' | 'auto';

export interface PermissionModeChangedContext {
  readonly mode: PermissionMode;
  readonly previousMode: PermissionMode;
}

/** pruned: `onDidChangeMode` Event stream omitted. */
export interface IAgentPermissionModeService {
  readonly _serviceBrand: undefined;

  readonly mode: PermissionMode;
  setMode(mode: PermissionMode): void;
}

export const IAgentPermissionModeService =
  createDecorator<IAgentPermissionModeService>('agentPermissionModeService');

// ---------------------------------------------------------------------------
// agent/permissionRules/permissionRules.ts
// ---------------------------------------------------------------------------

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface IAgentPermissionRulesService {
  readonly _serviceBrand: undefined;

  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
  addRules(rules: readonly PermissionRule[]): void;
  recordApprovalResult(record: PermissionApprovalResultRecord): void;
}

export const IAgentPermissionRulesService =
  createDecorator<IAgentPermissionRulesService>('agentPermissionRulesService');

// ---------------------------------------------------------------------------
// agent/plan/plan.ts
// ---------------------------------------------------------------------------

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string;
};

export interface IAgentPlanService {
  readonly _serviceBrand: undefined;

  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(id?: string): void;
  recordRevision(): Promise<void>;
  status(): Promise<PlanData>;
}

export const IAgentPlanService =
  createDecorator<IAgentPlanService>('agentPlanService');

// ---------------------------------------------------------------------------
// agent/profile/profile.ts
// ---------------------------------------------------------------------------

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

/** pruned: only the members the app calls through a typed proxy; the rest of
 * the v2 surface (bind/applyProfile/resolveRequestParams/…) types engine
 * internals (AgentProfile, ModelCapability, ModelRequestParams) that are not
 * used here. */
export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  setModel(model: string): Promise<ProfileSetModelResult>;
  getModel(): string;
  hasModel(): boolean;
  isRunnable(): boolean;
  refreshSystemPrompt(): Promise<void>;
}

export const IAgentProfileService = createDecorator<IAgentProfileService>('agentProfileService');

// ---------------------------------------------------------------------------
// agent/rpc/rpc.ts
// ---------------------------------------------------------------------------

/** pruned: the wire `ContentPart` union is narrowed to the text part the app
 * sends. */
export type PromptPart = {
  readonly type: string;
  readonly text?: string;
};

export interface PromptPayload {
  readonly input: readonly PromptPart[];
  readonly disabledTools?: readonly string[];
}

export interface CancelPayload {
  readonly turnId?: number;
}

/** pruned: only `prompt`/`cancel` are typed call sites (the v2 interface
 * extends the full `AgentAPI`). Results widened: `prompt` returns the
 * `PromptLaunchResult | undefined` wire shape as `unknown`. */
export interface IAgentRPCService {
  readonly _serviceBrand: undefined;

  prompt(payload: PromptPayload): unknown;
  cancel(payload: CancelPayload): void;
}

export const IAgentRPCService =
  createDecorator<IAgentRPCService>('agentRPCService');

// ---------------------------------------------------------------------------
// agent/swarm/swarm.ts
// ---------------------------------------------------------------------------

export type SwarmModeTrigger = 'manual' | 'task' | 'tool';

export interface IAgentSwarmService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: SwarmModeTrigger): void;
  exit(): void;
}

export const IAgentSwarmService = createDecorator<IAgentSwarmService>('agentSwarmService');

// ---------------------------------------------------------------------------
// agent/task/task.ts
// ---------------------------------------------------------------------------

/** pruned: results widened from the v2 `AgentTaskInfo` (types task internals);
 * `list`/`stop`/`stopAll` are the only members the AgentTaskService panel
 * calls. */
export interface IAgentTaskService {
  readonly _serviceBrand: undefined;

  list(activeOnly?: boolean, limit?: number): readonly unknown[];
  stop(taskId: string, reason?: string): Promise<unknown>;
  stopAll(reason?: string): Promise<readonly unknown[]>;
}

export const IAgentTaskService =
  createDecorator<IAgentTaskService>('agentTaskService');

// ---------------------------------------------------------------------------
// agent/toolRegistry/toolRegistry.ts
// ---------------------------------------------------------------------------

/** pruned: only `list` (the panel casts the result to `{ name?: string }[]`). */
export interface IAgentToolRegistryService {
  readonly _serviceBrand: undefined;

  list(): readonly unknown[];
}

export const IAgentToolRegistryService = createDecorator<IAgentToolRegistryService>('agentToolRegistryService');

// ---------------------------------------------------------------------------
// agent/usage/usage.ts
// ---------------------------------------------------------------------------

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

/** pruned: `record`/`onDidRecord` omitted (type the v2
 * `AgentLLMRequestSource`/Event). */
export interface IAgentUsageService {
  readonly _serviceBrand: undefined;

  status(): UsageStatus;
}

export const IAgentUsageService = createDecorator<IAgentUsageService>('agentUsageService');

// ---------------------------------------------------------------------------
// kosong/model/model.ts
// ---------------------------------------------------------------------------

/**
 * pruned: `oauth?`/`protocol?` fields dropped (they type the v2 `OAuthRef` /
 * `Protocol`); the catch-all index signature is kept so unknown fields
 * survive round-trips, as in v2.
 */
export interface ModelRecord {
  providerId?: string;

  baseUrl?: string;
  apiKey?: string;

  name?: string;
  aliases?: string[];

  provider?: string;
  model?: string;
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  betaApi?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;

  overrides?: ModelOverride;

  [key: string]: unknown;
}

/** From `kosong/model/model.ts` (same source package). */
export interface ModelOverride {
  maxContextSize?: number;
  maxInputSize?: number;
  maxOutputSize?: number;
  capabilities?: string[];
  displayName?: string;
  reasoningKey?: string;
  adaptiveThinking?: boolean;
  supportEfforts?: string[];
  defaultEffort?: string;
  offEffort?: string;
}

export interface IModelService {
  readonly _serviceBrand: undefined;

  /** pruned: `list` only. */
  list(): Readonly<Record<string, ModelRecord>>;
}

// The decorator name matches the legacy `app/model` contract (v2 comment:
// `createDecorator` caches by name — keeping the legacy name preserves the
// service identity every caller already resolves by).
export const IModelService: ServiceIdentifier<IModelService> =
  createDecorator<IModelService>('modelService');

// ---------------------------------------------------------------------------
// kosong/model/catalog.ts
// ---------------------------------------------------------------------------

/**
 * Wire shapes inferred from the v2 zod schemas (`modelCatalogItemSchema`,
 * `providerCatalogItemSchema`) — copied as plain types; the app does not need
 * the schemas themselves.
 */
export interface ModelCatalogItem {
  readonly provider: string;
  readonly model: string;
  readonly display_name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

export type ProviderCatalogStatus = 'connected' | 'error' | 'unconfigured';

export interface ProviderCatalogItem {
  readonly id: string;
  readonly type: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly has_api_key: boolean;
  readonly status: ProviderCatalogStatus;
  readonly models?: readonly string[];
}

export interface ModelPingResult {
  readonly ok: boolean;
  readonly durationMs: number;
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
  readonly error?: string;
}

/**
 * pruned: only the fields the app reads (`model`/`provider`/`resolved` are
 * rendered as JSON; `sources` feeds the provenance pane). The full v2 god
 * object types `ModelCapability`/`Protocol`/`ProviderConfig` internals.
 */
export interface ModelInspection {
  readonly id: string;
  readonly model: {
    readonly id: string;
    readonly record: ModelRecord;
    readonly effective: ModelRecord;
  };
  readonly provider: {
    readonly id: string;
    readonly synthesized: boolean;
  };
  readonly resolved: Record<string, unknown>;
  readonly sources: Readonly<Record<string, InspectionSource>>;
}

/** pruned: only the enumeration/inspection paths the app uses; the v2
 * `get`/`getRequester`/`setDefaultModel` paths type the pure-data `Model` /
 * `ModelRequester` internals. */
export interface IModelCatalog {
  readonly _serviceBrand: undefined;

  inspect(id: string): ModelInspection;
  ping(id: string): Promise<ModelPingResult>;
  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
}

// The decorator name matches the deleted legacy `IModelResolver` contract
// (v2 comment: `createDecorator` caches by name — keeping the legacy name
// preserves the service identity every caller already resolves by).
export const IModelCatalog: ServiceIdentifier<IModelCatalog> =
  createDecorator<IModelCatalog>('modelResolver');

// ---------------------------------------------------------------------------
// kosong/provider/provider.ts
// ---------------------------------------------------------------------------

/** pruned: `list` widened from `Readonly<Record<string, ProviderConfig>>`
 * (the ProviderService panel renders records as JSON). */
export interface IProviderService {
  readonly _serviceBrand: undefined;

  list(): Readonly<Record<string, unknown>>;
}

export const IProviderService: ServiceIdentifier<IProviderService> =
  createDecorator<IProviderService>('providerService');
