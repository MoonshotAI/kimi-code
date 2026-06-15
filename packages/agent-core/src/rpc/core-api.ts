import type { AgentConfigData } from '#/agent/config';
import type { AgentContextData } from '#/agent/context';
import type { BackgroundTaskInfo } from '#/agent/background';
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
import type { ToolInfo } from '#/agent/tool';
import type { KimiConfig, KimiConfigPatch, McpServerConfig } from '#/config';
import type { ExperimentalFeatureState } from '#/flags';
import type { ResumeSessionResult } from '#/rpc/resumed';
import type { SessionMeta } from '#/session';
import type { ContentPart } from '@moonshot-ai/kosong';

import type { PluginInfo, PluginSummary, ReloadSummary } from '#/plugin';
import type { UsageStatus } from './events';
import type { WithAgentId, WithSessionId } from './types';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export type Unsubscribe = () => void;

export type { KimiConfig, KimiConfigPatch };

export type TextPromptPart = Extract<ContentPart, { type: 'text' }>;
export type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

export type PromptInput = readonly PromptPart[];

export type EmptyPayload = {};
export type SessionMetadataPatch = Partial<Omit<SessionMeta, 'agents'>>;

export interface CreateSessionPayload {
  readonly id?: string | undefined;
  readonly workDir: string;
  readonly model?: string | undefined;
  readonly thinking?: string | undefined;
  readonly permission?: PermissionMode | undefined;
  readonly metadata?: JsonObject | undefined;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface CloseSessionPayload {
  readonly sessionId: string;
}

export interface ResumeSessionPayload {
  readonly sessionId: string;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface ReloadSessionPayload {
  readonly sessionId: string;
}

export interface ForkSessionPayload {
  readonly sessionId: string;
  readonly id?: string;
  readonly title?: string;
  readonly metadata?: JsonObject;
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
}

export interface PromptPayload {
  readonly input: readonly ContentPart[];
}
export interface SteerPayload {
  readonly input: readonly ContentPart[];
}
export interface CancelPayload {
  readonly turnId?: number;
}
export interface SetThinkingPayload {
  readonly level: string;
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
export interface RegisterToolPayload {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
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

export interface ReconnectMcpServerPayload {
  readonly name: string;
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

export interface AgentAPI {
  prompt: (payload: PromptPayload) => void;
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
  clearContext: (payload: EmptyPayload) => void;
  activateSkill: (payload: ActivateSkillPayload) => void;
  startBtw: (payload: EmptyPayload) => string;
  createGoal: (payload: CreateGoalPayload) => GoalSnapshot;
  getGoal: (payload: EmptyPayload) => GoalToolResult;
  pauseGoal: (payload: EmptyPayload) => GoalSnapshot;
  resumeGoal: (payload: EmptyPayload) => GoalSnapshot;
  cancelGoal: (payload: EmptyPayload) => GoalSnapshot;
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
  listMcpServers: (payload: EmptyPayload) => readonly McpServerInfo[];
  getMcpStartupMetrics: (payload: EmptyPayload) => McpStartupMetrics;
  reconnectMcpServer: (payload: ReconnectMcpServerPayload) => void;
  generateAgentsMd: (payload: EmptyPayload) => void;
}

type SessionAPIWithId = WithSessionId<SessionAPI>;

export interface CoreAPI extends SessionAPIWithId {
  getCoreInfo: (payload: EmptyPayload) => CoreInfo;
  getExperimentalFeatures: (payload: EmptyPayload) => readonly ExperimentalFeatureState[];
  getKimiConfig: (payload: GetKimiConfigPayload) => KimiConfig;
  getConfigDiagnostics: (payload: EmptyPayload) => ConfigDiagnostics;
  setKimiConfig: (payload: SetKimiConfigPayload) => KimiConfig;
  removeKimiProvider: (payload: RemoveKimiProviderPayload) => KimiConfig;
  createSession: (payload: CreateSessionPayload) => SessionSummary;
  closeSession: (payload: CloseSessionPayload) => void;
  resumeSession: (payload: ResumeSessionPayload) => ResumeSessionResult;
  reloadSession: (payload: ReloadSessionPayload) => ResumeSessionResult;
  forkSession: (payload: ForkSessionPayload) => ResumeSessionResult;
  listSessions: (payload: ListSessionsPayload) => readonly SessionSummary[];
  exportSession: (payload: ExportSessionPayload) => ExportSessionResult;
  listPlugins: (payload: EmptyPayload) => readonly PluginSummary[];
  installPlugin: (payload: InstallPluginPayload) => PluginSummary;
  setPluginEnabled: (payload: SetPluginEnabledPayload) => void;
  setPluginMcpServerEnabled: (payload: SetPluginMcpServerEnabledPayload) => void;
  removePlugin: (payload: RemovePluginPayload) => void;
  reloadPlugins: (payload: EmptyPayload) => ReloadPluginsResult;
  getPluginInfo: (payload: GetPluginInfoPayload) => PluginInfo;
}
