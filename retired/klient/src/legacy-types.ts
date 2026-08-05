/**
 * Legacy engine wire types — frozen local copies.
 *
 * The `@moonshot-ai/agent-core-v2` engine package is being retired (moved to
 * `retired/` and removed from the pnpm workspace). To keep the klient public
 * API surface and wire contract byte-identical, every type this package used
 * to import from the engine is copied here verbatim from its v2 source (see
 * the per-section attribution `packages/agent-core-v2/src/...`), then
 * re-exported under the same name. These copies are the new source of truth
 * for the wire contract; `test/contract-parity.ts` pins the zod schemas
 * against them.
 *
 * IMPORTANT: do not "fix" or modernize these declarations — they must stay
 * structurally identical to the retired engine types they mirror.
 */

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/_base/di/instantiation.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

/** DI service identifier (the engine's `createDecorator` return shape). */
export interface ServiceIdentifier<T> {
  (target: unknown, key: string | symbol | undefined, index: number): void;

  readonly type: T;

  toString(): string;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/_base/di/scope.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export enum LifecycleScope {
  App = 0,
  Session = 1,
  Agent = 2,
}

export interface ServicesAccessor {
  get<T>(serviceId: ServiceIdentifier<T>): T;
}

export interface IScopeHandle<K extends LifecycleScope = LifecycleScope> {
  readonly id: string;
  readonly kind: K;
  readonly accessor: ServicesAccessor;
  dispose(): void;
}

export type IAppScopeHandle = IScopeHandle<LifecycleScope.App>;
export type ISessionScopeHandle = IScopeHandle<LifecycleScope.Session>;
export type IAgentScopeHandle = IScopeHandle<LifecycleScope.Agent>;

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/persistence/interface/queryStore.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/contract/message.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  index?: number | string;
}

export type StreamedMessagePart = ContentPart | ToolCall | ToolCallPart;

export interface Message {
  readonly role: Role;
  readonly name?: string;
  readonly content: ContentPart[];
  readonly toolCalls: ToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
  readonly tools?: readonly Tool[];
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/contract/tool.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  deferred?: true;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/contract/usage.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/permissionPolicy/types.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export type PermissionMode = 'manual' | 'yolo' | 'auto';

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/contract/provider.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type ThinkingEffort = 'off' | 'on' | (string & {});

export type JsonSchemaObject = Record<string, unknown>;

export interface JsonObjectResponseFormat {
  readonly type: 'json_object';
}

export interface JsonSchemaResponseFormat {
  readonly type: 'json_schema';
  readonly jsonSchema: {
    readonly name: string;
    readonly schema: JsonSchemaObject;
    readonly strict?: boolean;
    readonly description?: string;
  };
}

export type ResponseFormat = JsonObjectResponseFormat | JsonSchemaResponseFormat;

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/protocol/protocol.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type Protocol = 'anthropic' | 'openai' | 'openai_responses' | 'google-genai';

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/provider/provider.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type ProviderType = string;

export interface OAuthRef {
  storage: 'file' | 'keyring';
  key: string;
  oauthHost?: string;
}

export type ModelSource = 'static' | 'discover' | 'oauth-catalog';

export interface ProviderConfig {
  modelSource?: ModelSource;

  baseUrl?: string;
  customHeaders?: Record<string, string>;
  defaultModel?: string;

  type?: ProviderType;
  apiKey?: string;
  oauth?: OAuthRef;
  env?: Record<string, string>;
  source?: Record<string, unknown>;
}

export interface ProvidersChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/model/model.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

export interface ModelRecord {
  providerId?: string;

  baseUrl?: string;
  apiKey?: string;
  oauth?: OAuthRef;

  protocol?: Protocol;

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

export interface ModelsChangedEvent {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/kosong/model/catalog.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

/** Wire catalog shapes (the engine defines these as zod-inferred types). */
export interface ModelCatalogItem {
  readonly provider: string;
  readonly model: string;
  readonly display_name?: string;
  readonly max_context_size: number;
  readonly capabilities?: readonly string[];
  readonly support_efforts?: readonly string[];
  readonly default_effort?: string;
}

export interface ProviderCatalogItem {
  readonly id: string;
  readonly type: string;
  readonly base_url?: string;
  readonly default_model?: string;
  readonly has_api_key: boolean;
  readonly status: 'connected' | 'error' | 'unconfigured';
  readonly models?: readonly string[];
}

export interface SetDefaultModelResponse {
  readonly default_model: string;
  readonly model: ModelCatalogItem;
}

export interface ModelRequester {
  request(
    input: unknown,
    signal?: AbortSignal,
    params?: unknown,
  ): AsyncIterable<StreamedMessagePart>;
}

export interface IModelCatalog {
  readonly _serviceBrand: undefined;

  getRequester(id: string): ModelRequester;
  listModels(): Promise<readonly ModelCatalogItem[]>;
  listProviders(): Promise<readonly ProviderCatalogItem[]>;
  getProvider(providerId: string): Promise<ProviderCatalogItem>;
  setDefaultModel(modelId: string): Promise<SetDefaultModelResponse>;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/kosongConfig/discovery.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

export interface RefreshProviderModelsResponse {
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
}

export type RefreshProviderModelsScope = 'all' | 'oauth';

export interface RefreshProviderModelsOptions {
  readonly scope?: RefreshProviderModelsScope;
  readonly providerId?: string;
}

export interface IProviderDiscoveryService {
  readonly _serviceBrand: undefined;

  refreshProviderModels(
    options?: RefreshProviderModelsOptions,
  ): Promise<RefreshProviderModelsResponse>;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/auth/oauthProtocol.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type OAuthFlowStatus =
  | 'pending'
  | 'authenticated'
  | 'denied'
  | 'expired'
  | 'cancelled';

export interface OAuthFlowStartPending {
  readonly flow_id: string;
  readonly provider: string;
  readonly status: 'pending';
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly interval: number;
  readonly expires_at: string;
}

export interface OAuthFlowStartAuthenticated {
  readonly flow_id: string;
  readonly provider: string;
  readonly status: 'authenticated';
}

export type OAuthFlowStart = OAuthFlowStartPending | OAuthFlowStartAuthenticated;

export interface OAuthFlowSnapshot {
  readonly flow_id: string;
  readonly provider: string;
  readonly status: OAuthFlowStatus;
  readonly verification_uri: string;
  readonly verification_uri_complete: string;
  readonly user_code: string;
  readonly expires_in: number;
  readonly expires_at: string;
  readonly interval: number;
  readonly resolved_at?: string;
  readonly error_message?: string;
}

export interface OAuthLoginCancelResponse {
  readonly cancelled: boolean;
  readonly status: OAuthFlowStatus;
}

export interface OAuthLogoutResponse {
  readonly logged_out: true;
  readonly provider: string;
}

export interface RefreshOAuthProviderModelsResponse {
  readonly changed: readonly ProviderRefreshChange[];
  readonly unchanged: readonly string[];
  readonly failed: readonly ProviderRefreshFailure[];
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/auth/auth.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface AuthStatus {
  readonly loggedIn: boolean;
  readonly provider?: string;
}

export interface IOAuthService {
  readonly _serviceBrand: undefined;

  startLogin(provider?: string): Promise<OAuthFlowStart>;
  getFlow(provider?: string): OAuthFlowSnapshot | undefined;
  cancelLogin(provider?: string): Promise<OAuthLoginCancelResponse>;
  logout(provider?: string): Promise<OAuthLogoutResponse>;
  status(provider?: string): Promise<AuthStatus>;
  refreshOAuthProviderModels(): Promise<RefreshOAuthProviderModelsResponse>;
}

export interface IAuthSummaryService {
  readonly _serviceBrand: undefined;

  summarize(): Promise<readonly AuthStatus[]>;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/flag/flag.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type FlagSurface = 'core' | 'tui' | 'both';

export type FlagId = string;

export type ExperimentalFlagSource = 'master-env' | 'env' | 'config' | 'default';

export interface ExperimentalFeatureState {
  readonly id: FlagId;
  readonly title: string;
  readonly description: string;
  readonly surface: FlagSurface;
  readonly env: string;
  readonly defaultEnabled: boolean;
  readonly enabled: boolean;
  readonly source: ExperimentalFlagSource;
  readonly configValue?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/hostFolderBrowser/hostFolderBrowser.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface FsBrowseEntry {
  readonly name: string;
  readonly path: string;
  readonly is_dir: true;
}

export interface FsBrowseResponse {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FsBrowseEntry[];
}

export interface FsHomeResponse {
  readonly home: string;
  readonly recent_roots: readonly string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/config/config.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type ConfigChangeSource = 'load' | 'reload' | 'set';

export interface ConfigChangedEvent {
  readonly domain: string;
  readonly source: ConfigChangeSource;
  readonly value: unknown;
  readonly previousValue: unknown;
}

export interface ConfigSectionChangedEvent {
  readonly domain: string;
  readonly source: ConfigChangeSource;
  readonly value: unknown;
  readonly previousValue: unknown;
}

export interface ConfigDiagnostic {
  readonly domain?: string;
  readonly severity: 'warning' | 'error';
  readonly message: string;
}

export enum ConfigTarget {
  User = 'user',
  Memory = 'memory',
}

export interface ConfigInspectValue<T = unknown> {
  readonly value: T | undefined;
  readonly defaultValue: T | undefined;
  readonly userValue: T | undefined;
  readonly memoryValue: T | undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/plugin/types.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type PluginDiagnosticSeverity = 'error' | 'warn' | 'info';

export interface PluginDiagnostic {
  readonly severity: PluginDiagnosticSeverity;
  readonly message: string;
}

export interface PluginAuthor {
  readonly name?: string;
  readonly email?: string;
}

export interface PluginSessionStart {
  readonly skill: string;
}

export interface PluginInterface {
  readonly displayName?: string;
  readonly shortDescription?: string;
  readonly longDescription?: string;
  readonly developerName?: string;
  readonly websiteURL?: string;
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly author?: PluginAuthor;
  readonly homepage?: string;
  readonly license?: string;
  readonly skills?: readonly string[];
  readonly sessionStart?: PluginSessionStart;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly hooks?: readonly HookDefConfig[];
  readonly commands?: readonly PluginCommandEntry[];
  readonly interface?: PluginInterface;
  readonly skillInstructions?: string;
}

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

export interface PluginCommandEntry {
  readonly path: string;
  readonly name: string;
}

export type PluginManifestKind = 'kimi-plugin-root' | 'kimi-plugin-dir';
export type PluginSource = 'local-path' | 'zip-url' | 'github';
export type PluginState = 'ok' | 'error';

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

export interface PluginInfo extends PluginSummary {
  readonly root: string;
  readonly installedAt: string;
  readonly updatedAt?: string;
  readonly manifestKind?: PluginManifestKind;
  readonly manifestPath?: string;
  readonly manifest?: PluginManifest;
  readonly mcpServers: readonly PluginMcpServerInfo[];
  readonly shadowedManifestPath?: string;
  readonly diagnostics: readonly PluginDiagnostic[];
}

export interface ReloadSummary {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly errors: ReadonlyArray<{ readonly id: string; readonly message: string }>;
}

export interface PluginUpdateStatus {
  readonly id: string;
  readonly source: PluginSource;
  readonly current?: PluginGithubRef;
  readonly latest: PluginGithubRef;
  readonly displayVersion: string;
  readonly updateAvailable: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/plugin/plugin.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface InstallPluginInput {
  readonly source: string;
}

export interface SetPluginEnabledInput {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SetPluginMcpServerEnabledInput {
  readonly id: string;
  readonly server: string;
  readonly enabled: boolean;
}

export interface RemovePluginInput {
  readonly id: string;
}

export interface GetPluginInfoInput {
  readonly id: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/externalHooks/configSection.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

/** The engine's `HOOK_EVENT_TYPES` array — frozen here as a union. */
export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PermissionRequest'
  | 'PermissionResult'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'StopFailure'
  | 'Interrupt'
  | 'SessionStart'
  | 'SessionEnd'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
  | 'Notification';

export interface HookDefConfig {
  readonly event: HookEventType;
  readonly matcher?: string;
  readonly command: string;
  readonly timeout?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/mcp/config-schema.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

interface McpServerCommonFields {
  readonly enabled?: boolean;
  readonly startupTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly enabledTools?: readonly string[];
  readonly disabledTools?: readonly string[];
}

export interface McpServerStdioConfig extends McpServerCommonFields {
  readonly transport: 'stdio';
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly executor?: 'local' | 'kaos';
}

export interface McpServerHttpConfig extends McpServerCommonFields {
  readonly transport: 'http';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bearerTokenEnvVar?: string;
}

export interface McpServerSseConfig extends McpServerCommonFields {
  readonly transport: 'sse';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly bearerTokenEnvVar?: string;
}

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig | McpServerSseConfig;

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/sessionIndex/sessionIndex.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/workspace/workspace.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/sessionLifecycle/sessionLifecycle.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

/** From `agent-core-v2/src/agent/profile/profile.ts` — `BindAgentInput`. */
export interface BindAgentInput {
  readonly profile: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly strictThinking?: boolean;
  readonly cwd?: string;
}

export interface CreateSessionOptions {
  readonly sessionId?: string;
  readonly workDir: string;
  readonly additionalDirs?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly mainAgentBinding?: BindAgentInput;
}

export interface ForkSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface CreateChildSessionOptions {
  readonly sourceSessionId: string;
  readonly newSessionId?: string;
  readonly title?: string;
  readonly metadata?: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/app/bootstrap/bootstrap.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export interface IBootstrapService {
  readonly _serviceBrand: undefined;

  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cwd: string;
  readonly osHomeDir: string;
  readonly homeDir: string;
  readonly configPath: string;
  readonly clientVersion: string;
  readonly sessionsDir: string;
  readonly blobsDir: string;
  readonly storeDir: string;
  readonly cacheDir: string;
  readonly logsDir: string;
  getEnv(name: string): string | undefined;
  scope(name: string): string;
  sessionScope(workspaceId: string, sessionId: string): string;
  agentScope(workspaceId: string, sessionId: string, agentId: string): string;
  sessionDir(workspaceId: string, sessionId: string): string;
  agentHomedir(workspaceId: string, sessionId: string, agentId: string): string;
  readonly configKey: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/session/approval/approval.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

/** From `agent-core-v2/src/tool/toolInputDisplay.ts` — the UI display hint union. */
export type ToolInputDisplay =
  | {
      kind: 'command';
      command: string;
      cwd?: string | undefined;
      description?: string | undefined;
      language?: 'bash' | undefined;
    }
  | {
      kind: 'file_io';
      operation: 'read' | 'write' | 'edit' | 'glob' | 'grep';
      path: string;
      detail?: string | undefined;
      content?: string | undefined;
      before?: string | undefined;
      after?: string | undefined;
    }
  | {
      kind: 'diff';
      path: string;
      before: string;
      after: string;
      hunks?: number | undefined;
    }
  | {
      kind: 'search';
      query: string;
      scope?: string | undefined;
    }
  | {
      kind: 'url_fetch';
      url: string;
      method?: string | undefined;
    }
  | {
      kind: 'agent_call';
      agent_name: string;
      prompt: string;
      background?: boolean | undefined;
    }
  | {
      kind: 'skill_call';
      skill_name: string;
      args?: string | undefined;
    }
  | {
      kind: 'todo_list';
      items: { title: string; status: string }[];
    }
  | {
      kind: 'task';
      task_id: string;
      status: string;
      description: string;
      task_kind?: string | undefined;
    }
  | {
      kind: 'task_stop';
      task_id: string;
      task_description: string;
    }
  | {
      kind: 'plan_review';
      plan: string;
      path?: string | undefined;
      options?: readonly { label: string; description: string }[] | undefined;
    }
  | {
      kind: 'goal_start';
      objective: string;
      completionCriterion?: string | undefined;
      mode: 'manual' | 'yolo';
    }
  | {
      kind: 'generic';
      summary: string;
      detail?: unknown;
    };

export interface ApprovalRequest {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/session/interaction/interaction.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/session/question/question.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/session/sessionMetadata/sessionMetadata.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentMeta {
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

export interface SessionMetadataChangedEvent {
  readonly changed: readonly (keyof SessionMeta)[];
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/task/types.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type AgentTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost';

export interface AgentTaskInfoBase {
  readonly taskId: string;
  readonly description: string;
  readonly status: AgentTaskStatus;
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
  readonly terminalNotificationSuppressed?: boolean;
  readonly timeoutMs?: number;
}

/**
 * The wire task union. In the engine this is the declaration-merged
 * `AgentTaskInfoByKind[AgentTaskKind]` (the protocol package augments the
 * `ByKind` map); the protocol `TaskInfo` union is the same shape.
 */
export interface AgentTaskInfoProcess extends AgentTaskInfoBase {
  readonly kind: 'process';
  readonly command: string;
  readonly pid: number;
  readonly exitCode: number | null;
}

export interface AgentTaskInfoAgent extends AgentTaskInfoBase {
  readonly kind: 'agent';
  readonly agentId?: string;
  readonly subagentType?: string;
}

export interface AgentTaskInfoQuestion extends AgentTaskInfoBase {
  readonly kind: 'question';
  readonly questionCount: number;
  readonly toolCallId?: string;
}

export type AgentTaskInfo = AgentTaskInfoProcess | AgentTaskInfoAgent | AgentTaskInfoQuestion;

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/contextMemory/types.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type SkillSource = 'project' | 'user' | 'extra' | 'builtin';

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
  readonly skillSource?: SkillSource | undefined;
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

export interface TaskOrigin {
  readonly kind: 'task';
  readonly taskId: string;
  readonly status: AgentTaskStatus;
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
  | CronJobOrigin
  | CronMissedOrigin
  | HookResultOrigin
  | RetryOrigin;

export type ContextMessage = Message & {
  readonly id?: string;
  readonly providerMessageId?: string;
  readonly origin?: PromptOrigin | undefined;
  readonly isError?: boolean;
  readonly note?: string;
};

export interface AgentContextData {
  history: readonly ContextMessage[];
  tokenCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/loop/turnEvents.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/activityView/activityView.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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

export interface ActivityTurnState {
  readonly turnId: number;
  readonly origin: PromptOrigin;
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

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/plan/plan.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

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
  status(): Promise<PlanData>;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/usage/usage.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export interface UsageStatus {
  readonly byModel?: Record<string, TokenUsage>;
  readonly total?: TokenUsage;
  readonly currentTurn?: TokenUsage;
}

export interface IAgentUsageService {
  readonly _serviceBrand: undefined;

  status(): UsageStatus;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/profile/profile.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface ProfileSetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface IAgentProfileService {
  readonly _serviceBrand: undefined;

  setModel(model: string): Promise<ProfileSetModelResult>;
  getModel(): string;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/shellCommand/shellCommand.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface RunShellCommandInput {
  readonly command: string;
  readonly commandId?: string;
}

export interface RunShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}

export interface IAgentShellCommandService {
  readonly _serviceBrand: undefined;

  run(input: RunShellCommandInput): Promise<RunShellCommandResult>;
  cancel(commandId: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/task/task.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export interface IAgentTaskService {
  readonly _serviceBrand: undefined;

  list(activeOnly?: boolean, limit?: number): readonly AgentTaskInfo[];
  stop(taskId: string, reason?: string): Promise<AgentTaskInfo | undefined>;
  stopByUser(taskId: string): Promise<AgentTaskInfo | undefined>;
  readOutput(taskId: string, tail?: number): Promise<string>;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/rpc/core-api.ts` (types only)
// ═══════════════════════════════════════════════════════════════════════════

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export type EmptyPayload = {};

export interface PromptPayload {
  readonly input: readonly ContentPart[];
  readonly disabledTools?: readonly string[];
}

export interface RunShellCommandPayload {
  readonly command: string;
  readonly commandId?: string;
}

export interface ShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly isError?: boolean;
  readonly backgrounded?: boolean;
}

export interface CancelShellCommandPayload {
  readonly commandId: string;
}

export interface SteerPayload {
  readonly input: readonly ContentPart[];
}

export interface CancelPayload {
  readonly turnId?: number;
}

export interface SetPermissionPayload {
  readonly mode: PermissionMode;
}

export interface SetModelPayload {
  readonly model: string;
}

export interface SetModelResult {
  readonly model: string;
  readonly providerName?: string | undefined;
}

export interface CancelPlanPayload {
  readonly id?: string;
}

export interface StopTaskPayload {
  readonly taskId: string;
  readonly reason?: string;
}

export interface GetTaskOutputPayload {
  readonly taskId: string;
  readonly tail?: number;
}

export interface GetTasksPayload {
  readonly activeOnly?: boolean;
  readonly limit?: number;
}

export interface PromptLaunchResult {
  readonly turn_id: number;
}

/** The `AgentAPI` methods the wire surface mirrors (subset of the engine's). */
export interface AgentAPI {
  prompt: (payload: PromptPayload) => PromptLaunchResult | undefined;
  steer: (payload: SteerPayload) => PromptLaunchResult | undefined;
  cancel: (payload: CancelPayload) => void;
  setPermission: (payload: SetPermissionPayload) => void;
  getContext: (payload: EmptyPayload) => AgentContextData;
}

// ═══════════════════════════════════════════════════════════════════════════
// From `agent-core-v2/src/agent/rpc/rpc.ts` (type only)
// ═══════════════════════════════════════════════════════════════════════════

export interface IAgentRPCService {
  readonly _serviceBrand: undefined;

  prompt(payload: PromptPayload): PromptLaunchResult | undefined;
  steer(payload: SteerPayload): PromptLaunchResult | undefined;
  cancel(payload: CancelPayload): void;
  setPermission(payload: SetPermissionPayload): void;
  getContext(payload: EmptyPayload): AgentContextData;
}
