/**
 * Core-owned types for the v2 facade (`#/core`).
 *
 * These replace the `@moonshot-ai/kimi-code-sdk` types the TUI used to
 * consume, now that it talks to `@moonshot-ai/agent-core-v2` directly. Shapes
 * follow two bounds: the fields the TUI actually reads are the lower bound,
 * and the v1 SDK types of the same name are the upper bound; only fields the
 * core facade will actually assign are kept. Fields v2 cannot provide yet stay
 * for shape parity and are marked `TODO(v2-gap)`.
 */

import type {
  AgentContextData,
  AgentReplayRecord,
  AgentTaskInfo,
  AgentTaskStatus,
  ConfigDiagnostic,
  ContentPart,
  ContextMessage,
  CreateGoalInput,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExportSessionResult,
  FlagId,
  GoalChange,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  IAgentShellCommandService,
  ModelCapability,
  PermissionData,
  PermissionMode,
  PlanData,
  PluginCommandDef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSummary,
  PromptOrigin,
  QuestionAnswers,
  ReloadSummary,
  ResolvedConfig,
  SessionMeta,
  ShellEnvironment,
  SkillSummary,
  SwarmModeTrigger,
  TokenUsage,
  ToolCall,
  ToolInfo,
  ToolUpdate,
  UsageStatus,
  WorkspaceAdditionalDirsResult,
} from '@moonshot-ai/agent-core-v2';
// These were deep-imported from v2 internal paths; the v2 barrel now re-exports
// them (`SessionApprovalRequest`/`SessionApprovalResponse` are barrel aliases
// that dodge the `permissionPolicy` name collision, question types are exported
// directly, and the two MCP types are type-only re-exports). The local
// `Core*`/`ApprovalResponse` names are kept for TUI compatibility.
import type {
  McpServerEntry,
  QuestionAnswerMethod,
  QuestionRequest as CoreQuestionRequest,
  QuestionResult,
  SessionApprovalRequest as CoreApprovalRequest,
  SessionApprovalResponse as ApprovalResponse,
} from '@moonshot-ai/agent-core-v2';
// Event2 payload types for the session-stream union below. The v2 barrel does
// not re-export most event modules; deep-import them the same way kap-server's
// `services/transcript/coreEventMap.ts` does.
import type { KimiErrorPayload } from '@moonshot-ai/agent-core-v2/_base/errors/serialize';
import type { HookResultPayload } from '@moonshot-ai/agent-core-v2/features/externalHooks/agent/agentExternalHooksService';
import type {
  CompactionBlockedPayload,
  CompactionCompletedPayload,
  CompactionStartedPayload,
} from '@moonshot-ai/agent-core-v2/agent/fullCompaction/compactionOps';
import type { GoalUpdatedPayload } from '@moonshot-ai/agent-core-v2/features/goal/goalOps';
import type {
  AssistantDeltaPayload,
  ThinkingDeltaPayload,
  ToolCallDeltaPayload,
  TurnStartedPayload,
  TurnStepCompletedPayload,
  TurnStepInterruptedPayload,
  TurnStepStartedPayload,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { TurnEndedPayload } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type {
  McpServerStatusEventPayload,
  ToolListUpdatedPayload,
} from '@moonshot-ai/agent-core-v2/agent/mcp/mcpEvents';
import type { PluginCommandActivatedPayload } from '@moonshot-ai/agent-core-v2/agent/pluginCommand/pluginCommand';
import type { WarningIssuedPayload } from '@moonshot-ai/agent-core-v2/agent/profile/profileOps';
import type {
  ShellOutputPayload,
  ShellStartedPayload,
} from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommandService';
import type { SkillActivatedPayload } from '@moonshot-ai/agent-core-v2/agent/skill/skillOps';
import type { TurnStepRetryingPayload } from '@moonshot-ai/agent-core-v2/agent/stepRetry/stepRetryService';
import type { TaskTerminatedNoticePayload } from '@moonshot-ai/agent-core-v2/agent/task/taskOps';
import type {
  ToolCallStartedPayload,
  ToolProgressPayload,
  ToolResultEventPayload,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { AgentStatusUpdatedPayload } from '@moonshot-ai/agent-core-v2/agent/usage/usageEvents';
import type { SubagentSuspendedPayload } from '@moonshot-ai/agent-core-v2/features/swarm/session/sessionSwarmService';
import type { CronFiredPayload } from '@moonshot-ai/agent-core-v2/features/cron/cronOps';
import type {
  SubagentCompletedPayload,
  SubagentFailedPayload,
  SubagentSpawnedPayload,
  SubagentStartedPayload,
} from '@moonshot-ai/agent-core-v2/session/subagent/mirrorAgentRun';

// v1 config-file schema shapes the TUI reads. Sourced from the node-sdk (which
// re-exports the agent-core v1 schema verbatim) instead of hand-copied here.
import type {
  ModelAlias,
  OAuthRef,
  ProviderConfig,
  ProviderType,
} from '@moonshot-ai/kimi-code-sdk';

export type {
  AgentReplayRecord,
  ApprovalResponse,
  CoreApprovalRequest,
  CoreQuestionRequest,
  QuestionAnswerMethod,
  QuestionResult,
};

/**
 * Agent-bus events delivered on the session stream, as a discriminated union
 * over the v2 `Event2` payloads. Successor of the pre-Event2 `DomainEvent`
 * union (upstream removed the augmentable `DomainEventMap` with the RPC
 * layer); mirrors the arms of kap-server's `ProjectorBusEvent`
 * (`services/transcript/coreEventMap.ts`) plus the MCP/shell events the TUI
 * consumes.
 */
export type DomainEvent =
  | ({ readonly type: 'turn.started' } & TurnStartedPayload)
  | ({ readonly type: 'turn.ended' } & TurnEndedPayload)
  | ({ readonly type: 'turn.step.started' } & TurnStepStartedPayload)
  | ({ readonly type: 'turn.step.completed' } & TurnStepCompletedPayload)
  | ({ readonly type: 'turn.step.interrupted' } & TurnStepInterruptedPayload)
  | ({ readonly type: 'turn.step.retrying' } & TurnStepRetryingPayload)
  | ({ readonly type: 'assistant.delta' } & AssistantDeltaPayload)
  | ({ readonly type: 'thinking.delta' } & ThinkingDeltaPayload)
  | ({ readonly type: 'tool.call.started' } & ToolCallStartedPayload)
  | ({ readonly type: 'tool.call.delta' } & ToolCallDeltaPayload)
  | ({ readonly type: 'tool.progress' } & ToolProgressPayload)
  | ({ readonly type: 'tool.result' } & ToolResultEventPayload)
  | ({ readonly type: 'agent.status.updated' } & AgentStatusUpdatedPayload)
  | ({ readonly type: 'goal.updated' } & GoalUpdatedPayload)
  | ({ readonly type: 'skill.activated' } & SkillActivatedPayload)
  | ({ readonly type: 'plugin_command.activated' } & PluginCommandActivatedPayload)
  | ({ readonly type: 'error' } & KimiErrorPayload)
  | ({ readonly type: 'warning' } & WarningIssuedPayload)
  | ({ readonly type: 'hook.result' } & HookResultPayload)
  | ({ readonly type: 'compaction.started' } & CompactionStartedPayload)
  | ({ readonly type: 'compaction.completed' } & CompactionCompletedPayload)
  | ({ readonly type: 'compaction.blocked' } & CompactionBlockedPayload)
  | { readonly type: 'compaction.cancelled' }
  | { readonly type: 'task.started'; readonly info: AgentTaskInfo }
  | ({ readonly type: 'task.terminated' } & TaskTerminatedNoticePayload)
  | ({ readonly type: 'cron.fired' } & CronFiredPayload)
  | ({ readonly type: 'subagent.spawned' } & SubagentSpawnedPayload)
  | ({ readonly type: 'subagent.started' } & SubagentStartedPayload)
  | ({ readonly type: 'subagent.completed' } & SubagentCompletedPayload)
  | ({ readonly type: 'subagent.failed' } & SubagentFailedPayload)
  | ({ readonly type: 'subagent.suspended' } & SubagentSuspendedPayload)
  | ({ readonly type: 'shell.started' } & ShellStartedPayload)
  | ({ readonly type: 'shell.output' } & ShellOutputPayload)
  | ({ readonly type: 'mcp.server.status' } & McpServerStatusEventPayload)
  | ({ readonly type: 'tool.list.updated' } & ToolListUpdatedPayload);

/**
 * App-bus `session.meta.updated` projection injected into the session stream
 * by `attachSessionEvents` / the harness rename re-emit. It is not part of the
 * v2 agent-bus `DomainEvent` union, so it is declared here to keep
 * `SessionEvent` truthful about what the stream actually delivers.
 */
export interface SessionMetaUpdatedPayload {
  readonly type: 'session.meta.updated';
  readonly title?: string;
  readonly patch?: Record<string, unknown>;
}

/** Merged event stream: native v2 payload plus routing context. */
export type SessionEvent = (DomainEvent | SessionMetaUpdatedPayload) & {
  readonly agentId: string;
  readonly sessionId: string;
};

/** Narrow the session stream union to a single event kind. */
export type SessionEventOf<K extends SessionEvent['type']> = Extract<
  SessionEvent,
  { readonly type: K }
>;

export interface PendingApproval {
  readonly id: string;
  readonly agentId: string;
  readonly request: CoreApprovalRequest;
}

export interface PendingQuestion {
  readonly id: string;
  readonly agentId: string;
  readonly request: CoreQuestionRequest;
}

export interface TelemetryClient {
  track(event: string, properties?: TelemetryProperties): void;
  setContext?(patch: TelemetryContextPatch): void;
  withContext?(patch: TelemetryContextPatch): TelemetryClient;
}
export type TelemetryProperties = Record<string, unknown>;
export type TelemetryContextPatch = Record<string, string | null>;

/**
 * Runtime status snapshot consumed by `/status` and `syncRuntimeState`.
 *
 * Field set copied verbatim from the v1 SDK `SessionStatus`
 * (`packages/node-sdk/src/types.ts`). Verified against the real engine in the
 * Task 5 smoke run: a fresh session reports
 * `{ thinkingEffort: 'off', permission: 'manual', planMode: false,
 * swarmMode: false, contextTokens: 0, maxContextTokens: 0, contextUsage: 0,
 * usage: {} }` — `model` is absent until one is bound (hence optional), and
 * every other field is always present. The v2 wire response also carries a
 * `status` activity field, which this projection intentionally drops (v1
 * parity). `swarmMode`/`usage` stay optional only for v1 shape parity; the
 * `getStatus` projection always assigns them.
 *
 * `rawContextTokens` is a v2-only addition (no v1 counterpart): the whole
 * stored-history estimate before projection folds, shown next to the
 * projected `contextTokens` on status surfaces.
 */
export interface SessionStatus {
  readonly model?: string;
  readonly thinkingEffort: string;
  readonly permission: PermissionMode;
  readonly planMode: boolean;
  readonly swarmMode?: boolean;
  readonly towerMode?: boolean;
  readonly contextTokens: number;
  readonly rawContextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  /** Merged from the main agent's `ISessionUsageService.status(...)` by `getStatus`. */
  readonly usage?: UsageStatus;
}

/**
 * Pre-session startup snapshot consumed by the TUI's initial render when no
 * session is created at startup. Every field comes from App-scope services
 * (config + model resolver), so `CoreHarness.getStartupState()` never has to
 * create a session to produce it. Semantics mirror `SessionStatus`: the first
 * lazily-created session reports the same values these defaults imply, unless
 * the user changed them in between.
 */
export interface CoreStartupState {
  /** Configured `defaultModel` alias; '' when none is set. */
  readonly model: string;
  /** Context window of `model`; 0 when unset or unresolvable (e.g. auth not ready). */
  readonly maxContextTokens: number;
  /** Configured `defaultPermissionMode`; 'manual' when unset or invalid. */
  readonly permissionMode: PermissionMode;
  /** Configured `defaultPlanMode`; false when unset. */
  readonly planMode: boolean;
  /**
   * Thinking level the first session would start at: the `thinking` config
   * default resolved through `resolveThinkingEffortForModel` with no requested
   * effort, clamped by the resolved model's metadata. 'off' when disabled or
   * no model resolves.
   */
  readonly thinkingEffort: ThinkingEffort;
}

/** Session list/summary projection consumed by the picker and `/export`. */
export interface CoreSessionSummary {
  readonly id: string;
  readonly title?: string;
  readonly lastPrompt?: string;
  readonly workDir: string;
  readonly sessionDir: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly additionalDirs?: readonly string[];
}

/**
 * Agent config snapshot for replay hydration. Field set mirrors the v1 wire
 * `AgentConfigData`; sourced from v2 `IAgentProfileService.data()` (whose
 * `thinkingLevel` maps to `thinkingEffort`).
 */
export interface ResumedAgentConfig {
  readonly cwd: string;
  /**
   * TODO(v2-gap): v2 has no per-agent provider config DTO; always undefined.
   * Kept so the TUI's `config.provider?.model` fallback keeps compiling.
   */
  readonly provider?: { readonly model?: string };
  readonly modelAlias?: string;
  readonly modelCapabilities: ModelCapability;
  readonly profileName?: string;
  readonly thinkingEffort: string;
  readonly systemPrompt: string;
}

/**
 * Per-agent resume snapshot, hydrated by `session-replay.ts` /
 * `message-replay.ts`. Shape mirrors the v1 wire `ResumedAgentState`
 * (`packages/agent-core/src/rpc/resumed.ts`) with the payload types swapped
 * to their v2 equivalents; `replay` reuses the v2 `AgentReplayRecord` union,
 * whose `message` variant carries the v2 `ContextMessage`.
 */
export interface ResumedAgentState {
  readonly type: 'main' | 'sub';
  readonly config: ResumedAgentConfig;
  readonly context: AgentContextData;
  readonly replay: readonly AgentReplayRecord[];
  readonly permission: PermissionData;
  readonly plan: PlanData;
  readonly swarmMode?: boolean;
  readonly usage: UsageStatus;
  readonly tools: readonly ToolInfo[];
  readonly toolStore?: Readonly<Record<string, unknown>>;
  readonly background: readonly AgentTaskInfo[];
}

/** Per-agent entry of the session metadata projection (v1 `AgentMeta` shape). */
export interface ResumedAgentMeta {
  readonly homedir: string;
  readonly type: 'main' | 'sub';
  readonly parentAgentId: string | null;
  readonly swarmItem?: string;
}

/**
 * Projection of v2 `ISessionMetadata.read()` into the v1 `SessionMeta` shape
 * (ISO timestamps, defaulted title). Limited to the fields the core replay
 * builder assigns; the TUI does not read it directly.
 */
export interface ResumedSessionMetadata {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly title: string;
  readonly isCustomTitle: boolean;
  readonly agents: Readonly<Record<string, ResumedAgentMeta>>;
}

/** Resume snapshot returned by `CoreSession.getResumeState()`. */
export interface ResumedSessionState {
  readonly sessionMetadata: ResumedSessionMetadata;
  readonly agents: Readonly<Record<string, ResumedAgentState>>;
  readonly warning?: string;
}

// ---------------------------------------------------------------------------
// Types appended for the `CoreSession` facade (session.ts).

/**
 * v1-protocol content parts accepted by `CoreSession.prompt` / `steer` —
 * mirrors the v1 wire `MessageContent` union (`@moonshot-ai/protocol`
 * message.ts), which apps/kimi-code does not depend on directly; same
 * mirroring pattern as `SessionWarning` below.
 */
export type PromptContent = PromptPart[];
export type PromptPart =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: PromptPartMediaSource }
  | { type: 'video'; source: PromptPartMediaSource }
  | { type: 'image_url'; imageUrl: { url: string; id?: string } }
  | { type: 'audio_url'; audioUrl: { url: string; id?: string } }
  | { type: 'video_url'; videoUrl: { url: string } }
  | { type: 'file'; file_id: string; name: string; media_type: string; size: number }
  | { type: 'thinking'; thinking: string; signature?: string };

type PromptPartMediaSource =
  | { kind: 'url'; url: string }
  | { kind: 'base64'; media_type: string; data: string }
  | { kind: 'file'; file_id: string };

/** Result of `CoreSession.runShellCommand` (the v2 shell-command service's shape). */
export type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;

/**
 * Session warning surfaced by `getSessionWarnings`. Mirrors the v1 wire
 * `SessionWarning` (`@moonshot-ai/protocol`), which the v2 barrel does not
 * re-export.
 */
export interface SessionWarning {
  readonly code: string;
  readonly message: string;
  readonly severity: 'info' | 'warning' | 'error';
}

/** v2 names used in `CoreSession` public signatures, re-exported for consumers. */
export type {
  AgentTaskInfo,
  ContentPart,
  ContextMessage,
  CreateGoalInput,
  GoalChange,
  GoalSnapshot,
  GoalToolResult,
  McpServerEntry,
  PermissionMode,
  PlanData,
  PromptOrigin,
  QuestionAnswers,
  SessionMeta,
  SkillSummary,
  SwarmModeTrigger,
  ToolCall,
  ToolUpdate,
  UsageStatus,
  WorkspaceAdditionalDirsResult,
};

/**
 * TODO(migrate): v1 SDK aliases kept so TUI components/utils that still read
 * the v1 names compile against the v2 shapes (which are structurally
 * compatible at runtime). New code should use the v2 names directly.
 */
export type BackgroundTaskInfo = AgentTaskInfo;
export type BackgroundTaskStatus = AgentTaskStatus;
/** v1 `SessionUsage` ≡ v2 `UsageStatus` (main-agent usage snapshot). */
export type SessionUsage = UsageStatus;

/**
 * TODO(migrate): Custom `tool.progress` update kind the v2 MCP auth tool emits
 * when an OAuth authorization URL is available. Value mirrors the protocol
 * constant (`@moonshot-ai/protocol` `events.ts`) so the TUI matches the
 * runtime update without importing the protocol package directly; drop once
 * agent-core-v2 or the protocol package exposes it through a supported export.
 */
export const MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE = 'mcp.oauth.authorization_url';

/**
 * TODO(migrate): Payload of {@link MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE}
 * custom progress updates; mirrored from the protocol package pending a
 * supported export.
 */
export interface McpOAuthAuthorizationUrlUpdateData {
  readonly serverName: string;
  readonly authorizationUrl: string;
}

/**
 * TODO(migrate): `mcp.server.status` event payload, mirrored from
 * `@moonshot-ai/protocol` (`events.ts`) so the TUI's MCP status util can read
 * the `server` snapshot without importing the protocol package directly; drop
 * once a supported export exists.
 */
export interface McpServerStatusPayload {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly status: 'pending' | 'connected' | 'failed' | 'disabled' | 'needs-auth';
  readonly toolCount: number;
  readonly error?: string;
}

/** TODO(migrate): Mirrored protocol event; drop with {@link McpServerStatusPayload}. */
export interface McpServerStatusEvent {
  readonly type: 'mcp.server.status';
  readonly server: McpServerStatusPayload;
}

// ---------------------------------------------------------------------------
// Types appended for the `CoreHarness` facade (harness.ts).

/**
 * Resolved config document, keyed by config domain — the v2
 * `IConfigService.getAll()` shape (v1 called this `KimiConfig`).
 */
export type CoreConfig = ResolvedConfig;

/** Config write patch: each entry is handed to `IConfigService.set(domain, value)`. */
export type CoreConfigPatch = Readonly<Record<string, unknown>>;

/**
 * v2 flag state entry (`IFlagService.explainAll()` element); named after the
 * "flag explanation" the TUI renders in `/config`.
 */
export type FlagExplanation = ExperimentalFeatureState;

/**
 * Input of `CoreHarness.exportSession`. Mirrors the v1 SDK shape (`id` instead
 * of the v2 payload's `sessionId`); the harness maps it onto the v2
 * `ISessionExportService.export` payload.
 */
export interface ExportSessionInput {
  readonly id: string;
  readonly outputPath?: string;
  /** Bundle the global diagnostic log into the zip (off by default). */
  readonly includeGlobalLog?: boolean;
  /** Host version to record in the export manifest. */
  readonly version: string;
  /** How the CLI was installed (e.g. 'npm-global', 'native'). */
  readonly installSource?: string;
  readonly shellEnv?: ShellEnvironment;
}

/** Safe description of one project-level MCP server that trusting would enable. */
export interface WorkspaceTrustMcpServerInfo {
  readonly name: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly url?: string;
}

/** Workspace-trust state for the startup gate (mirrors the v1 SDK shape). */
export interface WorkspaceTrustInfo {
  readonly trusted: boolean;
  /** Safe descriptions of project-level MCP servers that trusting would enable. */
  readonly gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[];
}

/** v2 names used in `CoreHarness` public signatures, re-exported for consumers. */
export type {
  AgentTaskStatus,
  ConfigDiagnostic,
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExportSessionResult,
  FlagId,
  GoalStatus,
  PluginCommandDef,
  PluginInfo,
  PluginMcpServerInfo,
  PluginSummary,
  ReloadSummary,
  ResolvedConfig,
  ShellEnvironment,
  TokenUsage,
};

/**
 * v1 wire name for the v2 `McpServerEntry` (the old name lived in the removed
 * RPC `core-api.ts`). Note v2 widened `status` with a `'removed'` member.
 */
export type McpServerInfo = McpServerEntry;

// ---------------------------------------------------------------------------
// Types appended for the TUI switchover (Task 6). These fill v1 SDK names the
// TUI still references but v2 does not export from its barrel.

/**
 * The `@moonshot-ai/protocol` `ToolInputDisplay`, extracted from the v2
 * approval request instead of imported directly — the protocol package is not
 * a dependency of this app.
 */
export type ToolInputDisplay = CoreApprovalRequest['display'];

/**
 * TODO(migrate): mirrors the v1 `ThinkingEffort` (kosong `provider.ts`). The
 * v2 profile service accepts plain strings; the alias keeps the TUI's literal
 * comparisons ('off' / 'on') type-safe.
 */
export type ThinkingEffort = 'off' | 'on' | (string & {});

// Re-exported from the node-sdk (the v1 config schema's home) so the TUI keeps
// reading the v1 shapes it is coupled to. TODO(migrate): drop once the TUI
// consumes v2-native config types.
export type { ModelAlias, OAuthRef, ProviderConfig, ProviderType };

/** TODO(migrate): derived from the v1 `ModelAlias.overrides` node (same shape as
 * the old hand-copied `ModelAliasOverrides`); drop with the re-exports above. */
export type ModelAliasOverrides = NonNullable<ModelAlias['overrides']>;


