import type { AgentConfigData } from '#/agent/config';
import type { AgentContextData } from '#/agent/context';
import type { BackgroundTaskInfo } from '#/agent/background';
import type { CronTaskSnapshot } from '#/agent/cron';
import type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from '#/agent/goal';
import type { PermissionData, PermissionMode } from '#/agent/permission';
import type { PlanData } from '#/agent/plan';
import type { SwarmModeTrigger } from '#/agent/swarm';
import type { ToolDisclosure, ToolInfo } from '#/agent/tool';
import type { KimiConfig, KimiConfigPatch, McpServerConfig } from '#/config';
import type { ExperimentalFeatureState } from '#/flags';
import type { ResumeSessionResult } from '#/rpc/resumed';
import type { SessionMeta } from '#/session';
import type { GlobalMcpServerConfig } from '#/mcp/global-config';
import type { McpServerConfigView } from '#/mcp/config-view';
import type { McpRegistryPluginOrigin, McpServerSource } from '#/mcp/registry';
import type { ContentPart } from '@moonshot-ai/kosong';
import type { SessionWarning } from '@moonshot-ai/protocol';

import type { PluginCommandDef, PluginInfo, PluginSummary, ReloadSummary } from '#/plugin';
import type { UsageStatus } from './events';
import type { WithAgentId, WithSessionId } from './types';

export type { PluginCommandDef } from '#/plugin';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type { KimiConfig, KimiConfigPatch };

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export type EmptyPayload = {};
export type SessionMetadataPatch = Partial<Omit<SessionMeta, 'agents' | 'additionalDirs'>>;

export interface ClientTelemetryInfo {
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly version?: string | undefined;
  readonly uiMode?: string | undefined;
}

export interface CreateSessionPayload {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly additionalDirs?: readonly string[];
  readonly client?: ClientTelemetryInfo | undefined;
  readonly drainAgentTasksOnStop?: boolean;
  /** Main-agent profile name (`--agent`): a builtin or agentfile-defined profile. */
  readonly agentProfile?: string;
  /** Explicit agentfiles (`--agent-file`); an invalid file fails session creation. */
  readonly agentFiles?: readonly string[];
}

export interface CloseSessionPayload {
  readonly sessionId: string;
}

export interface ArchiveSessionPayload {
  readonly sessionId: string;
}

export interface DeleteSessionPayload {
  readonly sessionId: string;
}

export interface ResumeSessionPayload {
  readonly sessionId: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly additionalDirs?: readonly string[];
  /** Re-select the session's already-bound main profile; a different name fails. */
  readonly agentProfile?: string;
  /** Include persisted subagent states in the returned replay snapshot. */
  readonly includeSubagents?: boolean;
  /**
   * Limit each returned agent replay to the most recent N user turns. Omit to
   * return the full replay. Lets UI callers that only render the tail avoid
   * serializing the entire history over the RPC boundary.
   */
  readonly replayTurnLimit?: number;
}

export interface ReloadSessionPayload {
  readonly sessionId: string;
  /**
   * When true, append a fresh `<plugin_session_start>` system reminder to the
   * main agent after the session is reloaded, reflecting the currently enabled
   * plugins. Used by the explicit `/reload` command so the model sees plugin
   * changes without starting a new session. Defaults to false.
   */
  readonly forcePluginSessionStartReminder?: boolean;
}

export interface ForkSessionPayload {
  readonly sessionId: string;
  readonly id?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
  /**
   * Zero-based index of the user-visible turn to retain through. When omitted,
   * the complete session is copied (the existing fork behavior).
   */
  readonly turnIndex?: number;
}

export interface ShellEnvironment {
  readonly term?: string | undefined;
  readonly termProgram?: string | undefined;
  readonly termProgramVersion?: string | undefined;
  readonly multiplexer?: string | undefined;
  readonly shell?: string | undefined;
}

export interface ExportSessionPayload {
  readonly sessionId: string;
  readonly outputPath?: string | undefined;
  /**
   * When true, the active global diagnostic log (`$KIMI_CODE_HOME/logs/kimi-code.log`)
   * is copied into the zip at `logs/global/kimi-code.log`. Off by default to
   * avoid bundling events from concurrent sessions / other projects.
   */
  readonly includeGlobalLog?: boolean | undefined;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionManifest {
  readonly sessionId: string;
  readonly exportedAt: string;
  readonly kimiCodeVersion: string;
  readonly wireProtocolVersion: string;
  readonly os: string;
  readonly nodejsVersion: string;
  readonly sessionFirstActivity?: string | undefined;
  readonly sessionLastActivity?: string | undefined;
  readonly title?: string | undefined;
  readonly workspaceDir?: string | undefined;
  /** zip-relative path to the session diagnostic log when present. */
  readonly sessionLogPath?: string | undefined;
  /** zip-relative path to the bundled global diagnostic log (only when --include-global-log). */
  readonly globalLogPath?: string | undefined;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string | undefined;
  readonly shellEnv?: ShellEnvironment | undefined;
}

export interface ExportSessionResult {
  readonly zipPath: string;
  readonly entries: readonly string[];
  readonly sessionDir: string;
  readonly manifest: ExportSessionManifest;
}

export interface ListSessionsPayload {
  readonly workDir?: string;
  readonly sessionId?: string;
  readonly includeArchive?: boolean;
}

export interface CoreInfo {
  readonly version: string;
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
  readonly metadata?: JsonObject | undefined;
  readonly additionalDirs?: readonly string[];
}

export interface PromptPayload {
  readonly input: readonly ContentPart[];
  /**
   * Client-managed session denylist, applied via
   * `IAgentProfileService.setSessionDisabledTools` before the prompt is
   * enqueued: full-replace semantics, the profile's own `disallowedTools`
   * always survive. Omit to keep the persisted value; `[]` clears the client
   * portion. Ignored by engines without profile support.
   */
  readonly disabledTools?: readonly string[];
}
export interface RunShellCommandPayload {
  readonly command: string;
  /**
   * TUI-generated correlation id echoed back on every `shell.output` live event
   * so the client can route chunks to the matching entry and drop stale events
   * from a prior run. Optional for callers that don't stream.
   */
  readonly commandId?: string;
}
export interface ShellCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  /** True when the command failed (non-zero exit / timeout / killed) — used by
   *  the TUI to render stderr in red only for actual failures, not warnings. */
  readonly isError?: boolean;
  /** True when the command was detached to the background (ctrl+b) instead of
   *  completing in the foreground. The TUI uses this to skip the normal final
   *  render (the backgrounding path owns the UI + model notification). */
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
export interface SetThinkingPayload {
  readonly effort: string;
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
export interface EnterSwarmPayload {
  readonly trigger: SwarmModeTrigger;
}
export interface BeginCompactionPayload {
  readonly instruction?: string;
}
export interface UndoHistoryPayload {
  readonly count: number;
}
export interface ImportContextPayload {
  /** Raw text supplied by the host. Core does not perform file I/O. */
  readonly content: string;
  /** User-facing description of the source, for example `file 'notes.md'`. */
  readonly source: string;
}
export interface RegisterToolPayload {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
  readonly disclosure?: ToolDisclosure;
}
export interface UnregisterToolPayload {
  readonly name: string;
}
export interface SetActiveToolsPayload {
  readonly names: readonly string[];
}
export interface StopBackgroundPayload {
  readonly taskId: string;
  /** Free-form human-readable reason persisted with the task record. */
  readonly reason?: string;
}
export interface DetachBackgroundPayload {
  readonly taskId: string;
}
export interface GetBackgroundOutputPayload {
  readonly taskId: string;
  readonly tail?: number;
}
export interface GetBackgroundPayload {
  /**
   * When omitted, returns all tasks (including terminal/lost). Pass
   * `true` to filter down to active-only — useful for model-facing
   * surfaces. UI/TUI consumers should leave it undefined.
   */
  readonly activeOnly?: boolean;
  /** Caps the number of tasks returned. When omitted, returns all matching tasks. */
  readonly limit?: number;
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

export interface ActivateSkillPayload {
  readonly name: string;
  readonly args?: string | undefined;
}

export interface ListWorkspaceSkillsPayload {
  readonly workDir: string;
}

export interface ActivatePluginCommandPayload {
  readonly pluginId: string;
  readonly commandName: string;
  readonly args?: string | undefined;
}

export interface McpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  // 'removed' is only produced by the v2 engine (config-driven tombstone);
  // v1 never emits it, but SDK consumers share this type across engines.
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth' | 'removed';
  readonly toolCount: number;
  readonly error?: string;
  /** Config origin tag (v1 only for now): global layered files / plugin / caller. */
  readonly source?: McpServerSource;
  /**
   * The effective config the entry is running (or last failed) with, in its
   * wire-facing view: stdio `env` / remote `headers` values are redacted to
   * key lists because they may carry credentials (v1 only for now).
   */
  readonly config?: AppMcpServerConfig;
}

export interface McpStartupMetrics {
  readonly durationMs: number;
}

export interface ReconnectMcpServerPayload {
  readonly name: string;
  /**
   * Optional full replacement config (the "name + full config" channel).
   * Omitted: the session re-resolves the current effective config from the
   * unified registry instead of reusing the boot-time snapshot.
   */
  readonly config?: McpServerConfig;
}

export interface AddSessionMcpServerPayload {
  readonly server: GlobalMcpServerConfig;
  /**
   * Also persist the server to the user-level `mcp.json`. Persisted entries
   * become `global`-sourced; unpersisted ones are session-local `caller`
   * entries.
   */
  readonly persist?: boolean;
}

export type { GlobalMcpServerConfig } from '#/mcp/global-config';
export type { McpServerSource } from '#/mcp/registry';

/**
 * One entry of the unified MCP management view: the effective config plus its
 * source metadata. `global` entries from the user-level file are `mutable`;
 * plugin and project-layer entries are read-only through the management API.
 * Read-only entries also withhold secret-bearing values: their stdio `env` /
 * remote `headers` are redacted to the `envKeys` / `headerKeys` lists, while
 * mutable (user-level) entries keep the full values so edit UIs can prefill.
 */
export type McpManagedServerInfo = GlobalMcpServerConfig & {
  readonly source: McpServerSource;
  /** global: defining file path; plugin: plugin id. */
  readonly origin: string;
  readonly mutable: boolean;
  readonly plugin?: McpRegistryPluginOrigin;
  /** Set instead of `env` / `headers` when the entry is read-only. */
  readonly envKeys?: readonly string[];
  readonly headerKeys?: readonly string[];
};

export interface ListGlobalMcpServersPayload {
  /** Include the project-root / project-local layers for this directory. */
  readonly cwd?: string;
}

export interface GetGlobalMcpServerPayload {
  readonly name: string;
  readonly cwd?: string;
}

export interface PutGlobalMcpServerPayload {
  readonly server: GlobalMcpServerConfig;
  readonly cwd?: string;
}

export interface GlobalMcpServerNamePayload {
  readonly name: string;
  readonly cwd?: string;
}

/**
 * Source-qualified server identity for the app-level MCP surface. Global
 * servers are addressed by their (runtime) name; plugin servers by plugin id
 * plus the manifest-local server name — the identity stays stable even when a
 * runtime-name collision makes the bare name ambiguous.
 */
export type McpServerLocator =
  | { readonly source: 'global'; readonly name: string }
  | {
      readonly source: 'plugin';
      readonly pluginId: string;
      readonly serverName: string;
    };

export interface McpServerLocatorPayload {
  readonly locator: McpServerLocator;
  readonly cwd?: string;
}

export interface InspectAppMcpServersPayload {
  readonly targets?: readonly McpServerLocator[];
  readonly cwd?: string;
}

export type GlobalMcpServerAuthState =
  | 'not-applicable'
  | 'bearer-token'
  | 'oauth-required'
  | 'oauth-authorized'
  // Stored credentials exist but are expired without a usable refresh token
  // (or failed an online verification): re-login required.
  | 'oauth-expired';

export interface GlobalMcpServerAuthStatus {
  readonly name: string;
  readonly authStatus: GlobalMcpServerAuthState;
}

export interface ListGlobalMcpServerAuthStatusesPayload {
  readonly cwd?: string;
  /**
   * Omitted preserves implicit OAuth detection for unpinned servers without
   * stored credentials. `false` stays fully offline; `true` verifies every
   * OAuth-capable server so an expired/revoked grant surfaces as
   * `oauth-expired` instead of the offline `oauth-authorized` guess.
   */
  readonly verify?: boolean;
}

/** App-level inspection adds `unavailable` (probe failed / ambiguous name). */
export type AppMcpServerAuthState = GlobalMcpServerAuthState | 'unavailable';

/**
 * Inspection config as exposed on the wire: the effective config with literal
 * stdio `env` / remote `headers` values redacted to sorted key lists, since
 * they may carry secrets. Shared with the session MCP status surface.
 */
export type AppMcpServerConfig = McpServerConfigView;

export interface AppMcpServerDescriptor {
  /** `global:<name>` or `plugin:<pluginId>:<serverName>` (URL-encoded parts). */
  readonly serverId: string;
  readonly locator: McpServerLocator;
  readonly runtimeName: string;
  readonly canonicalUrl: string | undefined;
  readonly origin: McpServerLocator['source'];
  /** The final effective config after source-specific transforms, redacted. */
  readonly config: AppMcpServerConfig;
  readonly enabled: boolean;
  readonly editable: boolean;
}

export interface AppMcpServerInspection extends AppMcpServerDescriptor {
  readonly authStatus: AppMcpServerAuthState;
  readonly checkedAt?: number;
  readonly error?: string;
}

export type BeginGlobalMcpServerAuthResult =
  | { readonly status: 'already-authorized' }
  | {
      readonly status: 'authorization-required';
      readonly flowId: string;
      readonly authorizationUrl: string;
    };

export interface CompleteGlobalMcpServerAuthPayload {
  readonly flowId: string;
  readonly timeoutMs?: number;
}

export interface CancelGlobalMcpServerAuthPayload {
  readonly flowId: string;
}

export interface TestGlobalMcpServerPayload {
  /** Registry lookup by name (covers plugin and project-layer entries). */
  readonly name?: string;
  /** Probe a full inline config instead — nothing has to be saved first. */
  readonly server?: GlobalMcpServerConfig;
  readonly cwd?: string;
}

export interface GlobalMcpServerTestResult {
  readonly success: boolean;
  readonly output: string;
}

export interface InstallPluginPayload {
  readonly source: string;
}

export interface SetPluginEnabledPayload {
  readonly id: string;
  readonly enabled: boolean;
}

export interface SetPluginMcpServerEnabledPayload {
  readonly id: string;
  readonly server: string;
  readonly enabled: boolean;
}

export interface RemovePluginPayload {
  readonly id: string;
}

export interface GetPluginInfoPayload {
  readonly id: string;
}

export type ReloadPluginsResult = ReloadSummary;
export type { PluginSummary, PluginInfo };

export interface AddAdditionalDirPayload {
  readonly path: string;
  readonly persist: boolean;
}

export interface AddAdditionalDirResult {
  readonly additionalDirs: readonly string[];
  readonly projectRoot: string;
  readonly configPath: string;
  readonly persisted: boolean;
}

export interface RenameSessionPayload {
  readonly title: string;
}

export interface UpdateSessionMetadataPayload {
  readonly metadata: SessionMetadataPatch;
}

// Goal lifecycle payloads and re-exported goal value types. These describe the
// deterministic user/SDK control surface; the goal's terminal status is decided
// by the model via the UpdateGoal tool (or the goal driver on budget/error),
// not set through this API.
export type {
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
};

export interface CreateGoalPayload {
  readonly objective: string;
  readonly replace?: boolean;
}

export interface GetKimiConfigPayload {
  readonly reload?: boolean;
}

export interface ConfigDiagnostics {
  /** Warnings from the most recent config.toml load attempt; empty when the config is fully valid. */
  readonly warnings: readonly string[];
}

export type SetKimiConfigPayload = KimiConfigPatch;

export interface RemoveKimiProviderPayload {
  readonly providerId: string;
}

export interface GetCronTasksResult {
  readonly tasks: readonly CronTaskSnapshot[];
}

export interface AgentAPI {
  prompt: (payload: PromptPayload) => void;
  runShellCommand: (payload: RunShellCommandPayload) => Promise<ShellCommandResult>;
  cancelShellCommand: (payload: CancelShellCommandPayload) => void;
  steer: (payload: SteerPayload) => void;
  cancel: (payload: CancelPayload) => void;
  undoHistory: (payload: UndoHistoryPayload) => void;
  setThinking: (payload: SetThinkingPayload) => void;
  setPermission: (payload: SetPermissionPayload) => void;
  setModel: (payload: SetModelPayload) => SetModelResult;
  getModel: (payload: EmptyPayload) => string;
  enterPlan: (payload: EmptyPayload) => void;
  cancelPlan: (payload: CancelPlanPayload) => void;
  clearPlan: (payload: EmptyPayload) => void;
  enterSwarm: (payload: EnterSwarmPayload) => void;
  exitSwarm: (payload: EmptyPayload) => void;
  getSwarmMode: (payload: EmptyPayload) => boolean;
  beginCompaction: (payload: BeginCompactionPayload) => void;
  cancelCompaction: (payload: EmptyPayload) => void;
  registerTool: (payload: RegisterToolPayload) => void;
  unregisterTool: (payload: UnregisterToolPayload) => void;
  setActiveTools: (payload: SetActiveToolsPayload) => void;
  stopBackground: (payload: StopBackgroundPayload) => void;
  detachBackground: (payload: DetachBackgroundPayload) => BackgroundTaskInfo | undefined;
  clearContext: (payload: EmptyPayload) => void;
  importContext: (payload: ImportContextPayload) => void;
  activateSkill: (payload: ActivateSkillPayload) => void;
  activatePluginCommand: (payload: ActivatePluginCommandPayload) => void;
  startBtw: (payload: EmptyPayload) => string;
  createGoal: (payload: CreateGoalPayload) => GoalSnapshot;
  getGoal: (payload: EmptyPayload) => GoalToolResult;
  pauseGoal: (payload: EmptyPayload) => GoalSnapshot;
  resumeGoal: (payload: EmptyPayload) => GoalSnapshot;
  cancelGoal: (payload: EmptyPayload) => GoalSnapshot;
  getCronTasks: (payload: EmptyPayload) => GetCronTasksResult;
  getBackgroundOutput: (payload: GetBackgroundOutputPayload) => string;
  getContext: (payload: EmptyPayload) => AgentContextData;
  getConfig: (payload: EmptyPayload) => AgentConfigData;
  getPermission: (payload: EmptyPayload) => PermissionData;
  getPlan: (payload: EmptyPayload) => PlanData;
  getUsage: (payload: EmptyPayload) => UsageStatus;
  getTools: (payload: EmptyPayload) => readonly ToolInfo[];
  getBackground: (payload: GetBackgroundPayload) => readonly BackgroundTaskInfo[];
}

type AgentAPIWithId = WithAgentId<AgentAPI>;

export interface SessionAPI extends AgentAPIWithId {
  renameSession: (payload: RenameSessionPayload) => void;
  updateSessionMetadata: (payload: UpdateSessionMetadataPayload) => void;
  getSessionMetadata: (payload: EmptyPayload) => SessionMeta;
  listSkills: (payload: EmptyPayload) => readonly SkillSummary[];
  listPluginCommands: (payload: EmptyPayload) => readonly PluginCommandDef[];
  listMcpServers: (payload: EmptyPayload) => readonly McpServerInfo[];
  getMcpStartupMetrics: (payload: EmptyPayload) => McpStartupMetrics;
  reconnectMcpServer: (payload: ReconnectMcpServerPayload) => void;
  generateAgentsMd: (payload: EmptyPayload) => void;
  getSessionWarnings: (payload: EmptyPayload) => readonly SessionWarning[];
  waitForBackgroundTasksOnPrint: (payload: EmptyPayload) => void;
  handlePrintMainTurnCompleted: (payload: EmptyPayload) => 'finish' | 'continue';
  addAdditionalDir: (payload: AddAdditionalDirPayload) => AddAdditionalDirResult;
}

type SessionAPIWithId = WithSessionId<SessionAPI>;

export interface CoreAPI extends SessionAPIWithId {
  applyPersistedSecondaryModel: (payload: EmptyPayload & { readonly sessionId: string }) => void;
  getCoreInfo: (payload: EmptyPayload) => CoreInfo;
  getExperimentalFeatures: (payload: EmptyPayload) => readonly ExperimentalFeatureState[];
  getKimiConfig: (payload: GetKimiConfigPayload) => KimiConfig;
  getConfigDiagnostics: (payload: EmptyPayload) => ConfigDiagnostics;
  setKimiConfig: (payload: SetKimiConfigPayload) => KimiConfig;
  removeKimiProvider: (payload: RemoveKimiProviderPayload) => KimiConfig;
  listGlobalMcpServers: (
    payload: ListGlobalMcpServersPayload,
  ) => readonly McpManagedServerInfo[];
  getGlobalMcpServer: (payload: GetGlobalMcpServerPayload) => McpManagedServerInfo;
  listGlobalMcpServerAuthStatuses: (
    payload: ListGlobalMcpServerAuthStatusesPayload,
  ) => readonly GlobalMcpServerAuthStatus[];
  /**
   * App-level inspection: every known server (global + plugin) with its
   * effective config and its real authorization state, probing OAuth
   * candidates over a throwaway connection. `targets` narrows to specific
   * locators; omitted inspects all.
   */
  inspectAppMcpServers: (
    payload: InspectAppMcpServersPayload,
  ) => readonly AppMcpServerInspection[];
  addGlobalMcpServer: (payload: PutGlobalMcpServerPayload) => readonly McpManagedServerInfo[];
  updateGlobalMcpServer: (payload: PutGlobalMcpServerPayload) => readonly McpManagedServerInfo[];
  removeGlobalMcpServer: (
    payload: GlobalMcpServerNamePayload,
  ) => readonly McpManagedServerInfo[];
  beginGlobalMcpServerAuth: (
    payload: GlobalMcpServerNamePayload,
  ) => BeginGlobalMcpServerAuthResult;
  /** Locator-addressed variants, covering plugin servers as first-class. */
  beginMcpServerAuth: (payload: McpServerLocatorPayload) => BeginGlobalMcpServerAuthResult;
  completeGlobalMcpServerAuth: (payload: CompleteGlobalMcpServerAuthPayload) => void;
  completeMcpServerAuth: (payload: CompleteGlobalMcpServerAuthPayload) => void;
  cancelGlobalMcpServerAuth: (payload: CancelGlobalMcpServerAuthPayload) => void;
  cancelMcpServerAuth: (payload: CancelGlobalMcpServerAuthPayload) => void;
  resetGlobalMcpServerAuth: (payload: GlobalMcpServerNamePayload) => void;
  resetMcpServerAuth: (payload: McpServerLocatorPayload) => void;
  testGlobalMcpServer: (payload: TestGlobalMcpServerPayload) => GlobalMcpServerTestResult;
  /**
   * Session-level add: connect a server in one live session, optionally
   * persisting it to the user-level `mcp.json` (`persist: true`, making it a
   * `global` entry; otherwise it stays a session-local `caller` entry).
   */
  addSessionMcpServer: (
    payload: AddSessionMcpServerPayload & { readonly sessionId: string },
  ) => McpServerInfo;
  createSession: (payload: CreateSessionPayload) => SessionSummary;
  closeSession: (payload: CloseSessionPayload) => void;
  archiveSession: (payload: ArchiveSessionPayload) => void;
  deleteSession: (payload: DeleteSessionPayload) => void;
  resumeSession: (payload: ResumeSessionPayload) => ResumeSessionResult;
  reloadSession: (payload: ReloadSessionPayload) => ResumeSessionResult;
  forkSession: (payload: ForkSessionPayload) => ResumeSessionResult;
  listSessions: (payload: ListSessionsPayload) => readonly SessionSummary[];
  exportSession: (payload: ExportSessionPayload) => ExportSessionResult;
  listWorkspaceSkills: (payload: ListWorkspaceSkillsPayload) => Promise<readonly SkillSummary[]>;
  listPlugins: (payload: EmptyPayload) => readonly PluginSummary[];
  installPlugin: (payload: InstallPluginPayload) => PluginSummary;
  setPluginEnabled: (payload: SetPluginEnabledPayload) => void;
  setPluginMcpServerEnabled: (payload: SetPluginMcpServerEnabledPayload) => void;
  removePlugin: (payload: RemovePluginPayload) => void;
  reloadPlugins: (payload: EmptyPayload) => ReloadPluginsResult;
  getPluginInfo: (payload: GetPluginInfoPayload) => PluginInfo;
}
