/**
 * Compile-time parity checks between klient wire schemas and the engine
 * types they mirror. Plain `.ts` (not `.test.ts`) — vitest must not pick it
 * up; `tsc -p tsconfig.json --noEmit` is the check.
 *
 * Wire shapes the engine imports from `@moonshot-ai/protocol` are reached
 * through indexed access on the engine service interfaces, since klient does
 * not depend on the protocol package directly.
 */

import type { z } from 'zod';

import type {
  ActivityLastTurnState,
  ActivityRetryState,
  ActivityTurnState,
  ActivityViewLifecycle,
  AgentActivityState,
  ApprovalRef,
  BackgroundRef,
  ToolCallRef,
  TurnPhase,
} from '@moonshot-ai/agent-core-v2/agent/activityView/activityView';
import type { AgentContextData } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import type { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { IAgentPromptService } from '@moonshot-ai/agent-core-v2/agent/prompt/prompt';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentSkillService } from '@moonshot-ai/agent-core-v2/agent/skill/skill';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
import type { PlanData } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import type { UsageStatus } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';
import type { McpServerEntry } from '@moonshot-ai/agent-core-v2/mcpCore/connection-manager';
import type { FullCompactionInput } from '@moonshot-ai/agent-core-v2/agent/fullCompaction/fullCompaction';
import type { ISessionScopeHandle } from '@moonshot-ai/agent-core-v2/_base/di/scope';
import type {
  CreateChildSessionOptions,
  CreateSessionOptions,
  ForkSessionOptions,
  ResumeSessionOptions,
} from '@moonshot-ai/agent-core-v2/workspace/sessionLifecycle/sessionLifecycle';
import type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
import type {
  Interaction,
  InteractionResolution,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
import type {
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
import type {
  AgentMeta,
  SessionMeta,
  SessionMetadataChangedEvent,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
import type { ISessionTitleService } from '@moonshot-ai/agent-core-v2/session/sessionTitle/sessionTitle';
import type {
  AuthStatus,
  IOAuthService,
} from '@moonshot-ai/agent-core-v2/app/auth/auth';
import type { IBootstrapService } from '@moonshot-ai/agent-core-v2/app/bootstrap/bootstrap';
import type {
  ConfigDiagnostic,
  ConfigInspectValue,
  ConfigTarget,
} from '@moonshot-ai/agent-core-v2/app/config/config';
import type {
  CapabilityInstallProgress,
  CapabilityStatus,
  CapabilityStep,
} from '@moonshot-ai/agent-core-v2/app/capability/types';
import type { ExperimentalFeatureState } from '@moonshot-ai/agent-core-v2/app/flag/flag';
import type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import type { ModelRecord } from '@moonshot-ai/agent-core-v2/kosong/model/model';
import type { IModelCatalog } from '@moonshot-ai/agent-core-v2/kosong/model/catalog';
import type { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import type {
  GetPluginInfoInput,
  InstallPluginInput,
  RemovePluginInput,
  SetPluginEnabledInput,
  SetPluginMcpServerEnabledInput,
} from '@moonshot-ai/agent-core-v2/app/plugin/plugin';
import type {
  PluginCommandDef,
  PluginDiagnostic,
  PluginGithubMetadata,
  PluginInfo,
  PluginManifest,
  PluginMcpServerInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from '@moonshot-ai/agent-core-v2/app/plugin/types';
import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
import type {
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import type {
  Workspace,
  WorkspaceUpdate,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
// Test-only: `@moonshot-ai/protocol` is a devDependency; importing its types
// here (never in `src/`) strengthens parity for the agent event stream.
import type {
  AssistantDeltaEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  PromptAbortedEvent,
  PromptCompletedEvent,
  TaskInfo,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  WarningEvent,
} from '@moonshot-ai/protocol';

import {
  activityLastTurnStateSchema,
  activityRetryStateSchema,
  activityTurnStateSchema,
  activityViewLifecycleSchema,
  agentActivityStateSchema,
  approvalRefSchema,
  backgroundRefSchema,
  toolCallRefSchema,
  turnEndReasonSchema,
  turnPhaseSchema,
} from '../src/contract/agent/activity.js';
import {
  agentCommandInfoSchema,
  agentContextDataSchema,
  agentTaskInfoSchema,
  activateSkillPayloadSchema,
  cancelPayloadSchema,
  cancelPlanPayloadSchema,
  cancelShellCommandPayloadSchema,
  emptyPayloadSchema,
  getTaskOutputPayloadSchema,
  getTasksPayloadSchema,
  planDataSchema,
  promptLaunchResultSchema,
  promptPartSchema,
  promptPayloadSchema,
  runCommandPayloadSchema,
  runShellCommandPayloadSchema,
  setModelPayloadSchema,
  setModelResultSchema,
  setPermissionPayloadSchema,
  shellCommandResultSchema,
  steerPayloadSchema,
  stopTaskPayloadSchema,
  tokenUsageSchema,
  usageStatusSchema,
} from '../src/contract/agent/schemas.js';
import {
  assistantDeltaEventSchema,
  compactionBlockedEventSchema,
  compactionCancelledEventSchema,
  compactionCompletedEventSchema,
  compactionStartedEventSchema,
  promptAbortedEventSchema,
  promptCompletedEventSchema,
  thinkingDeltaEventSchema,
  toolCallDeltaEventSchema,
  toolCallStartedEventSchema,
  toolProgressEventSchema,
  toolResultEventSchema,
  turnEndedEventSchema,
  turnStartedEventSchema,
  warningEventSchema,
} from '../src/contract/agent/events.js';
import {
  approvalRequestSchema,
  approvalResponseSchema,
} from '../src/contract/session/approval.js';
import {
  fullCompactionInputSchema,
  mcpServerEntrySchema,
} from '../src/contract/agent/services.js';
import {
  createChildSessionOptionsSchema,
  createSessionOptionsSchema,
  forkSessionOptionsSchema,
  handleWireSchema,
  resumeSessionOptionsSchema,
} from '../src/contract/session/lifecycle.js';
import {
  interactionResolutionSchema,
  interactionSchema,
} from '../src/contract/session/interaction.js';
import {
  agentMetaSchema,
  sessionMetaPatchSchema,
  sessionMetaSchema,
  sessionMetadataChangedEventSchema,
} from '../src/contract/session/metadata.js';
import {
  questionAnswersSchema,
  questionItemSchema,
  questionOptionSchema,
  questionRequestSchema,
  questionResponseSchema,
  questionResultSchema,
} from '../src/contract/session/question.js';
import { skillSummarySchema } from '../src/contract/session/skills.js';
import { sessionTitleContract } from '../src/contract/session/title.js';

import {
  authStatusSchema,
  oAuthFlowSnapshotSchema,
  oAuthFlowStartSchema,
  oAuthLoginCancelResponseSchema,
  oAuthLogoutResponseSchema,
  refreshOAuthProviderModelsResponseSchema,
} from '../src/contract/global/auth.js';
import {
  configDiagnosticSchema,
  configInspectValueSchema,
  configTargetSchema,
} from '../src/contract/global/config.js';
import {
  capabilityInstallProgressSchema,
  capabilityStatusSchema,
  capabilityStepSchema,
} from '../src/contract/global/capabilities.js';
import {
  modelCatalogItemSchema,
  providerCatalogItemSchema,
  setDefaultModelResponseSchema,
} from '../src/contract/global/catalog.js';
import {
  refreshProviderModelsOptionsSchema,
  refreshProviderModelsResponseSchema,
} from '../src/contract/global/providerDiscovery.js';
import { experimentalFeatureStateSchema } from '../src/contract/global/flags.js';
import {
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '../src/contract/global/hostFs.js';
import { modelConfigSchema } from '../src/contract/global/models.js';
import {
  getPluginInfoInputSchema,
  installPluginInputSchema,
  pluginCommandDefSchema,
  pluginDiagnosticSchema,
  pluginGithubMetadataSchema,
  pluginInfoSchema,
  pluginManifestSchema,
  pluginMcpServerInfoSchema,
  pluginSummarySchema,
  pluginUpdateStatusSchema,
  reloadSummarySchema,
  removePluginInputSchema,
  setPluginEnabledInputSchema,
  setPluginMcpServerEnabledInputSchema,
} from '../src/contract/global/plugins.js';
import { providerConfigSchema } from '../src/contract/global/providers.js';
import {
  sessionListQuerySchema,
  sessionSummarySchema,
} from '../src/contract/global/sessions.js';
import {
  workspaceSchema,
  workspaceUpdateSchema,
} from '../src/contract/global/workspaces.js';

import type { AssertWire, MutableDeep } from './helpers/typeAssert.js';
import type { AgentFacade } from '../src/core/facade/agent.js';

/** One-directional: the engine type must be assignable TO the schema's infer. */
type AssertEngineToWire<TSchema extends z.ZodType, TEngine> = [MutableDeep<TEngine>] extends [
  z.infer<TSchema>,
]
  ? true
  : never;

/** One-directional: the schema's infer must be assignable TO the engine type. */
type AssertWireToEngine<TSchema extends z.ZodType, TEngine> = [z.infer<TSchema>] extends [
  MutableDeep<TEngine>,
]
  ? true
  : never;

// Protocol wire shapes, derived from the engine interfaces (no direct
// `@moonshot-ai/protocol` dependency in klient).
type OAuthFlowStart = Awaited<ReturnType<IOAuthService['startLogin']>>;
type OAuthFlowSnapshot = NonNullable<ReturnType<IOAuthService['getFlow']>>;
type OAuthLoginCancelResponse = Awaited<ReturnType<IOAuthService['cancelLogin']>>;
type OAuthLogoutResponse = Awaited<ReturnType<IOAuthService['logout']>>;
type RefreshOAuthProviderModelsResponse = Awaited<
  ReturnType<IOAuthService['refreshOAuthProviderModels']>
>;
/** String-enum value union (`'user' | 'memory'`). */
type ConfigTargetValues = `${ConfigTarget}`;

// sessions.ts
const _sessionSummary: AssertWire<typeof sessionSummarySchema, SessionSummary> = true;
const _sessionListQuery: AssertWire<typeof sessionListQuerySchema, SessionListQuery> = true;

// workspaces.ts
const _workspace: AssertWire<typeof workspaceSchema, Workspace> = true;
const _workspaceUpdate: AssertWire<typeof workspaceUpdateSchema, WorkspaceUpdate> = true;

// config.ts
// One-directional: the engine declares the `ConfigInspectValue` keys as
// required with `| undefined` values, while the wire schema marks them
// `.optional()`; optional → required is not assignable, so only the
// engine → wire direction holds.
const _configInspectValue: AssertEngineToWire<typeof configInspectValueSchema, ConfigInspectValue> =
  true;
const _configDiagnostic: AssertWire<typeof configDiagnosticSchema, ConfigDiagnostic> = true;
const _configTarget: AssertWire<typeof configTargetSchema, ConfigTargetValues> = true;

// capabilities.ts
const _capabilityStep: AssertWire<typeof capabilityStepSchema, CapabilityStep> = true;
const _capabilityInstallProgress: AssertWire<
  typeof capabilityInstallProgressSchema,
  CapabilityInstallProgress
> = true;
const _capabilityStatus: AssertWire<typeof capabilityStatusSchema, CapabilityStatus> = true;

// providers.ts
const _providerConfig: AssertWire<typeof providerConfigSchema, ProviderConfig> = true;

// auth.ts
const _oAuthFlowStart: AssertWire<typeof oAuthFlowStartSchema, OAuthFlowStart> = true;
const _oAuthFlowSnapshot: AssertWire<typeof oAuthFlowSnapshotSchema, OAuthFlowSnapshot> = true;
const _oAuthLoginCancelResponse: AssertWire<
  typeof oAuthLoginCancelResponseSchema,
  OAuthLoginCancelResponse
> = true;
const _oAuthLogoutResponse: AssertWire<typeof oAuthLogoutResponseSchema, OAuthLogoutResponse> =
  true;
const _authStatus: AssertWire<typeof authStatusSchema, AuthStatus> = true;
const _refreshOAuthProviderModelsResponse: AssertWire<
  typeof refreshOAuthProviderModelsResponseSchema,
  RefreshOAuthProviderModelsResponse
> = true;

// flags.ts
const _experimentalFeatureState: AssertWire<
  typeof experimentalFeatureStateSchema,
  ExperimentalFeatureState
> = true;

// hostFs.ts
const _fsBrowseResponse: AssertWire<typeof fsBrowseResponseSchema, FsBrowseResponse> = true;
const _fsHomeResponse: AssertWire<typeof fsHomeResponseSchema, FsHomeResponse> = true;

// catalog.ts / providerDiscovery.ts — protocol wire shapes derived through the
// catalog and discovery service interfaces.
type ModelCatalogItem = Awaited<ReturnType<IModelCatalog['listModels']>>[number];
type ProviderCatalogItem = Awaited<ReturnType<IModelCatalog['listProviders']>>[number];
type SetDefaultModelResponse = Awaited<ReturnType<IModelCatalog['setDefaultModel']>>;
type RefreshProviderModelsOptions = NonNullable<
  Parameters<IProviderDiscoveryService['refreshProviderModels']>[0]
>;
type RefreshProviderModelsResponse = Awaited<
  ReturnType<IProviderDiscoveryService['refreshProviderModels']>
>;
const _modelCatalogItem: AssertWire<typeof modelCatalogItemSchema, ModelCatalogItem> = true;
const _providerCatalogItem: AssertWire<typeof providerCatalogItemSchema, ProviderCatalogItem> =
  true;
const _setDefaultModelResponse: AssertWire<
  typeof setDefaultModelResponseSchema,
  SetDefaultModelResponse
> = true;
const _refreshProviderModelsOptions: AssertWire<
  typeof refreshProviderModelsOptionsSchema,
  RefreshProviderModelsOptions
> = true;
const _refreshProviderModelsResponse: AssertWire<
  typeof refreshProviderModelsResponseSchema,
  RefreshProviderModelsResponse
> = true;

// models.ts
const _modelConfig: AssertWire<typeof modelConfigSchema, ModelRecord> = true;

// plugins.ts
const _pluginSummary: AssertWire<typeof pluginSummarySchema, PluginSummary> = true;
const _pluginInfo: AssertWire<typeof pluginInfoSchema, PluginInfo> = true;
const _pluginManifest: AssertWire<typeof pluginManifestSchema, PluginManifest> = true;
const _pluginMcpServerInfo: AssertWire<typeof pluginMcpServerInfoSchema, PluginMcpServerInfo> =
  true;
const _pluginDiagnostic: AssertWire<typeof pluginDiagnosticSchema, PluginDiagnostic> = true;
const _pluginGithubMetadata: AssertWire<typeof pluginGithubMetadataSchema, PluginGithubMetadata> =
  true;
const _reloadSummary: AssertWire<typeof reloadSummarySchema, ReloadSummary> = true;
const _pluginUpdateStatus: AssertWire<typeof pluginUpdateStatusSchema, PluginUpdateStatus> = true;
const _pluginCommandDef: AssertWire<typeof pluginCommandDefSchema, PluginCommandDef> = true;
const _installPluginInput: AssertWire<typeof installPluginInputSchema, InstallPluginInput> = true;
const _setPluginEnabledInput: AssertWire<
  typeof setPluginEnabledInputSchema,
  SetPluginEnabledInput
> = true;
const _setPluginMcpServerEnabledInput: AssertWire<
  typeof setPluginMcpServerEnabledInputSchema,
  SetPluginMcpServerEnabledInput
> = true;
const _removePluginInput: AssertWire<typeof removePluginInputSchema, RemovePluginInput> = true;
const _getPluginInfoInput: AssertWire<typeof getPluginInfoInputSchema, GetPluginInfoInput> = true;

// env.ts has no named schemas; `platform` narrows to `NodeJS.Platform` in the
// engine — assert the bootstrap properties are all strings instead. The
// object-typed `clientIdentity` is intentionally not in this list.
type _bootstrapStringProps = AssertStringProps<
  Pick<
    IBootstrapService,
    | 'platform'
    | 'arch'
    | 'cwd'
    | 'osHomeDir'
    | 'homeDir'
    | 'configPath'
    | 'sessionsDir'
    | 'blobsDir'
    | 'storeDir'
    | 'cacheDir'
    | 'logsDir'
  >
>;
type AssertStringProps<T> = T extends Record<string, string> ? true : never;
const _envProps: _bootstrapStringProps = true;

// ── session scope ───────────────────────────────────────────────────────────

// session/metadata.ts
const _sessionMeta: AssertWire<typeof sessionMetaSchema, SessionMeta> = true;
const _agentMeta: AssertWire<typeof agentMetaSchema, AgentMeta> = true;
const _sessionMetaPatch: AssertWire<typeof sessionMetaPatchSchema, SessionMetaPatch> = true;
const _sessionMetadataChangedEvent: AssertWire<
  typeof sessionMetadataChangedEventSchema,
  SessionMetadataChangedEvent
> = true;

// session/lifecycle.ts
const _createSessionOptions: AssertWire<typeof createSessionOptionsSchema, CreateSessionOptions> =
  true;
const _forkSessionOptions: AssertWire<typeof forkSessionOptionsSchema, ForkSessionOptions> = true;
const _resumeSessionOptions: AssertWire<typeof resumeSessionOptionsSchema, ResumeSessionOptions> =
  true;
const _createChildSessionOptions: AssertWire<
  typeof createChildSessionOptionsSchema,
  CreateChildSessionOptions
> = true;
// One-directional: the wire handle is `z.looseObject` — the in-process
// `ISessionScopeHandle` carries an `accessor` and `dispose()` that JSON
// drops, so only the engine → wire direction holds.
const _handleWire: AssertEngineToWire<typeof handleWireSchema, ISessionScopeHandle> = true;

// session/interaction.ts
const _interaction: AssertWire<typeof interactionSchema, Interaction> = true;
const _interactionResolution: AssertWire<
  typeof interactionResolutionSchema,
  InteractionResolution
> = true;

// session/approval.ts
// One-directional: `display` is the protocol `ToolInputDisplay` union (huge)
// and crosses the wire as `unknown`; the wire schema cannot be assignable
// back to the engine type.
const _approvalRequest: AssertEngineToWire<typeof approvalRequestSchema, ApprovalRequest> = true;
const _approvalResponse: AssertWire<typeof approvalResponseSchema, ApprovalResponse> = true;

// session/question.ts
const _questionRequest: AssertWire<typeof questionRequestSchema, QuestionRequest> = true;
const _questionItem: AssertWire<typeof questionItemSchema, QuestionItem> = true;
const _questionOption: AssertWire<typeof questionOptionSchema, QuestionOption> = true;
const _questionAnswers: AssertWire<typeof questionAnswersSchema, QuestionAnswers> = true;
const _questionResponse: AssertWire<typeof questionResponseSchema, QuestionResponse> = true;
const _questionResult: AssertWire<typeof questionResultSchema, QuestionResult> = true;

// session/skills.ts
const _skillSummary: AssertWire<typeof skillSummarySchema, SkillSummary> = true;

// session/title.ts
const _generateTitleOutput: AssertWire<
  (typeof sessionTitleContract)['generateTitle']['output'],
  Awaited<ReturnType<ISessionTitleService['generateTitle']>>
> = true;

// agent/activity.ts
const _turnPhase: AssertWire<typeof turnPhaseSchema, TurnPhase> = true;
const _approvalRef: AssertWire<typeof approvalRefSchema, ApprovalRef> = true;
const _toolCallRef: AssertWire<typeof toolCallRefSchema, ToolCallRef> = true;
const _activityRetryState: AssertWire<typeof activityRetryStateSchema, ActivityRetryState> = true;
// One-directional: `origin` is the deep `PromptOrigin` union mirrored as
// `unknown`; the wire schema cannot be assignable back to the engine type.
const _activityTurnState: AssertEngineToWire<typeof activityTurnStateSchema, ActivityTurnState> =
  true;
const _turnEndReason: AssertWire<typeof turnEndReasonSchema, TurnEndReason> = true;
const _activityLastTurnState: AssertWire<
  typeof activityLastTurnStateSchema,
  ActivityLastTurnState
> = true;
const _backgroundRef: AssertWire<typeof backgroundRefSchema, BackgroundRef> = true;
const _activityViewLifecycle: AssertWire<typeof activityViewLifecycleSchema, ActivityViewLifecycle> =
  true;
const _agentActivityState: AssertEngineToWire<typeof agentActivityStateSchema, AgentActivityState> =
  true;

// ── agent scope (services.ts / schemas.ts) ──────────────────────────────────
// Payload/result types are derived from the domain service interfaces the
// facade calls, so the assertions track the exact methods the contract
// mirrors; facade-only payload shapes (cancel / setPermission / plan / task /
// command) derive from the `AgentFacade` input types.
type PromptPayload = Parameters<IAgentPromptService['submit']>[0];
type PromptLaunchResult = NonNullable<Awaited<ReturnType<IAgentPromptService['submit']>>>;
type SteerPayload = Parameters<IAgentPromptService['submitSteer']>[0];
type ActivateSkillPayload = Parameters<IAgentSkillService['activate']>[0];
type AgentCommandInfo = ReturnType<IAgentCommandService['list']>[number];
type RunShellCommandPayload = Parameters<IAgentShellCommandService['run']>[0];
type ShellCommandResult = Awaited<ReturnType<IAgentShellCommandService['run']>>;
type SetModelResult = Awaited<ReturnType<IAgentProfileService['setModel']>>;
type TokenUsage = NonNullable<UsageStatus['total']>;
type PromptPart = Extract<ContentPart, { type: 'text' | 'image_url' | 'video_url' }>;

type EmptyPayload = {};
type CancelPayload = NonNullable<Parameters<AgentFacade['cancel']>[0]>;
type SetPermissionPayload = { mode: PermissionMode };
type RunCommandPayload = Parameters<AgentFacade['runCommand']>[0];
type CancelShellCommandPayload = Parameters<AgentFacade['cancelShellCommand']>[0];
type SetModelPayload = { model: string };
type CancelPlanPayload = NonNullable<Parameters<AgentFacade['cancelPlan']>[0]>;
type GetTasksPayload = NonNullable<Parameters<AgentFacade['getTasks']>[0]>;
type StopTaskPayload = Parameters<AgentFacade['stopTask']>[0];
type GetTaskOutputPayload = Parameters<AgentFacade['getTaskOutput']>[0];

const _emptyPayload: AssertWire<typeof emptyPayloadSchema, EmptyPayload> = true;
const _promptPart: AssertWire<typeof promptPartSchema, PromptPart> = true;
// One-directional (wire → engine): the engine's `PromptPayload.input` accepts
// the full `ContentPart` union (also think/audio parts); the wire mirrors the
// `PromptPart` subset clients may send, so the reverse direction fails.
const _promptPayload: AssertWireToEngine<typeof promptPayloadSchema, PromptPayload> = true;
const _steerPayload: AssertWireToEngine<typeof steerPayloadSchema, SteerPayload> = true;
const _activateSkillPayload: AssertWire<typeof activateSkillPayloadSchema, ActivateSkillPayload> =
  true;
const _promptLaunchResult: AssertWire<typeof promptLaunchResultSchema, PromptLaunchResult> = true;
const _cancelPayload: AssertWire<typeof cancelPayloadSchema, CancelPayload> = true;
const _runShellCommandPayload: AssertWire<
  typeof runShellCommandPayloadSchema,
  RunShellCommandPayload
> = true;
const _shellCommandResult: AssertWire<typeof shellCommandResultSchema, ShellCommandResult> = true;
const _cancelShellCommandPayload: AssertWire<
  typeof cancelShellCommandPayloadSchema,
  CancelShellCommandPayload
> = true;
const _setModelPayload: AssertWire<typeof setModelPayloadSchema, SetModelPayload> = true;
const _setModelResult: AssertWire<typeof setModelResultSchema, SetModelResult> = true;
const _setPermissionPayload: AssertWire<typeof setPermissionPayloadSchema, SetPermissionPayload> =
  true;
const _tokenUsage: AssertWire<typeof tokenUsageSchema, TokenUsage> = true;
const _usageStatus: AssertWire<typeof usageStatusSchema, UsageStatus> = true;
// One-directional: `history` entries are full `ContextMessage`s (deep
// `Message`/`Tool`/`PromptOrigin` unions) mirrored as `unknown`.
const _agentContextData: AssertEngineToWire<typeof agentContextDataSchema, AgentContextData> = true;
const _agentCommandInfo: AssertWire<typeof agentCommandInfoSchema, AgentCommandInfo> = true;
const _runCommandPayload: AssertWire<typeof runCommandPayloadSchema, RunCommandPayload> = true;
const _planData: AssertWire<typeof planDataSchema, PlanData> = true;
const _cancelPlanPayload: AssertWire<typeof cancelPlanPayloadSchema, CancelPlanPayload> = true;
const _getTasksPayload: AssertWire<typeof getTasksPayloadSchema, GetTasksPayload> = true;
// The wire task union mirrors the protocol `TaskInfo`; the engine's
// declaration-merged `AgentTaskInfo` is structurally identical but depends on
// tool-module augmentation, so parity is pinned to the protocol type.
const _agentTaskInfo: AssertWire<typeof agentTaskInfoSchema, TaskInfo> = true;
const _stopTaskPayload: AssertWire<typeof stopTaskPayloadSchema, StopTaskPayload> = true;
const _getTaskOutputPayload: AssertWire<typeof getTaskOutputPayloadSchema, GetTaskOutputPayload> =
  true;

// agent/services.ts (mcp / fullCompaction)
const _mcpServerEntry: AssertWire<typeof mcpServerEntrySchema, McpServerEntry> = true;
const _fullCompactionInput: AssertWire<typeof fullCompactionInputSchema, FullCompactionInput> =
  true;

// ── agent scope (events.ts) ─────────────────────────────────────────────────
// Parity against the protocol event types (the stream carries flat
// `{ type, ... }` events; schemas keep the `type` literal). One-directional
// where a field is mirrored as `unknown`.
const _turnStartedEvent: AssertEngineToWire<typeof turnStartedEventSchema, TurnStartedEvent> = true;
const _turnEndedEvent: AssertEngineToWire<typeof turnEndedEventSchema, TurnEndedEvent> = true;
const _assistantDeltaEvent: AssertWire<typeof assistantDeltaEventSchema, AssistantDeltaEvent> =
  true;
const _thinkingDeltaEvent: AssertWire<typeof thinkingDeltaEventSchema, ThinkingDeltaEvent> = true;
const _toolCallStartedEvent: AssertEngineToWire<
  typeof toolCallStartedEventSchema,
  ToolCallStartedEvent
> = true;
const _toolCallDeltaEvent: AssertWire<typeof toolCallDeltaEventSchema, ToolCallDeltaEvent> = true;
const _toolProgressEvent: AssertWire<typeof toolProgressEventSchema, ToolProgressEvent> = true;
const _toolResultEvent: AssertWire<typeof toolResultEventSchema, ToolResultEvent> = true;
const _promptCompletedEvent: AssertWire<typeof promptCompletedEventSchema, PromptCompletedEvent> =
  true;
const _promptAbortedEvent: AssertWire<typeof promptAbortedEventSchema, PromptAbortedEvent> = true;
const _compactionStartedEvent: AssertWire<
  typeof compactionStartedEventSchema,
  CompactionStartedEvent
> = true;
const _compactionBlockedEvent: AssertWire<
  typeof compactionBlockedEventSchema,
  CompactionBlockedEvent
> = true;
const _compactionCancelledEvent: AssertWire<
  typeof compactionCancelledEventSchema,
  CompactionCancelledEvent
> = true;
const _compactionCompletedEvent: AssertWire<
  typeof compactionCompletedEventSchema,
  CompactionCompletedEvent
> = true;
const _warningEvent: AssertWire<typeof warningEventSchema, WarningEvent> = true;
// No parity assertions for `errorEventSchema`, `permissionApproval*Schema`,
// and `agentStatusUpdatedEventSchema`: they are deliberately `z.looseObject`s
// (index signature breaks both-ways assignability) — `permission.approval.*`
// is not part of the protocol event union at all.
