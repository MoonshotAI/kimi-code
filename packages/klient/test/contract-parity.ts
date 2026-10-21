import type { z } from 'zod';

import type { AgentContextData } from '@moonshot-ai/agent-core-v2/agent/contextMemory/types';
import type { IAgentCommandService } from '@moonshot-ai/agent-core-v2/agent/command/agentCommand';
import type { IAgentRuntimeBindingService } from '@moonshot-ai/agent-core-v2/agent/runtimeBinding/runtimeBinding';
import type { TurnEndReason } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { SessionActivityState } from '@moonshot-ai/agent-core-v2/session/sessionActivity/sessionActivity';
import type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
import type { IAgentProfileService } from '@moonshot-ai/agent-core-v2/agent/profile/profile';
import type { PromptLaunchResult, PromptPayload, SteerPayload } from '@moonshot-ai/agent-core-v2/agent/loop/loop';
import type { IAgentShellCommandService } from '@moonshot-ai/agent-core-v2/agent/shellCommand/shellCommand';
import type { IAgentSkillService } from '@moonshot-ai/agent-core-v2/features/skill/skillService';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
import type { PlanData } from '@moonshot-ai/agent-core-v2/features/plan/plan';
import type { UsageStatus } from '@moonshot-ai/agent-core-v2/agent/usage/usage';
import type { SkillSummary } from '@moonshot-ai/agent-core-v2/features/skill/catalog/types';
import type { McpServerEntry } from '@moonshot-ai/agent-core-v2/mcpCore/connection-manager';
import type {
  GlobalMcpServerConfig,
  McpAuthStatusQuery,
  McpManagedServer,
  McpServerAuthBeginResult,
  McpServerAuthFlowHandle,
  McpServerAuthState,
  McpServerAuthStatus,
  McpServerInspection,
  McpServerLocator,
  McpServerTestResult,
  McpServerTestTarget,
} from '@moonshot-ai/agent-core-v2/app/mcpManagement/mcpManagement';
import type {
  McpRegistryPluginOrigin,
  McpRegistryQuery,
  McpServerSource,
} from '@moonshot-ai/agent-core-v2/app/mcpRegistry/mcpRegistry';
import type { McpServerConfig } from '@moonshot-ai/agent-core-v2/mcpCore/config-schema';
import type { McpServerConfigView } from '@moonshot-ai/agent-core-v2/mcpCore/configView';
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
} from '@moonshot-ai/agent-core-v2/agent/interaction/approval';
import type {
  Interaction,
  InteractionResolution,
} from '@moonshot-ai/agent-core-v2/human/interaction/interaction';
import type {
  QuestionAnswers,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/agent/interaction/question';
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
  FileMeta,
  SaveOptions,
} from '@moonshot-ai/agent-core-v2/app/file/fileService';
import type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import type { ModelRecord } from '@moonshot-ai/agent-core-v2/llm-adapter/model/model';
import type { IModelCatalog } from '@moonshot-ai/agent-core-v2/llm-adapter/model/catalog';
import type { IProviderDiscoveryService } from '@moonshot-ai/agent-core-v2/app/kosongConfig/discovery';
import type {
  ImportCustomRegistryOptions,
  ImportCustomRegistryResult,
} from '@moonshot-ai/agent-core-v2/app/kosongConfig/modelsDevImport';
import {
  importCustomRegistryOptionsSchema,
  importCustomRegistryResultSchema,
} from '../src/contract/global/registryImport.js';
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
import type { ProviderConfig } from '@moonshot-ai/agent-core-v2/llm-adapter/provider/provider';
import type {
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import type {
  Workspace,
  WorkspaceUpdate,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
import type { ToolResultEvent } from '@moonshot-ai/agent-core-v2/events';
import type {
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
} from '@moonshot-ai/agent-core-v2/agent/fullCompaction/compactionOps';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  TurnStartedEvent,
} from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import type { TurnEndedEvent } from '@moonshot-ai/agent-core-v2/agent/loop/turnOps';
import type {
  PromptAbortedEvent,
  PromptCompletedEvent,
} from '@moonshot-ai/agent-core-v2/agent/prompt/promptEvents';
import type { TaskInfo } from '@moonshot-ai/agent-core-v2/agent/task/types';
import type {
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
} from '@moonshot-ai/agent-core-v2/agent/toolExecutor/toolExecutorEvents';
import type { WarningEvent } from '@moonshot-ai/agent-core-v2/errors';

import { sessionActivityStateSchema } from '../src/contract/session/activity.js';
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
  promptSkillActivationSchema,
  promptWithSkillsPayloadSchema,
  promptWithSkillsResultSchema,
  runCommandPayloadSchema,
  runShellCommandPayloadSchema,
  runtimeBindingSchema,
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
  fileMetaSchema,
  fileSaveOptionsSchema,
} from '../src/contract/global/files.js';
import {
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '../src/contract/global/hostFs.js';
import { modelConfigSchema } from '../src/contract/global/models.js';
import {
  globalMcpServerConfigSchema,
  mcpAuthStatusQuerySchema,
  mcpManagedServerSchema,
  mcpRegistryPluginOriginSchema,
  mcpRegistryQuerySchema,
  mcpServerAuthBeginResultSchema,
  mcpServerAuthFlowHandleSchema,
  mcpServerAuthStateSchema,
  mcpServerAuthStatusSchema,
  mcpServerConfigDataSchema,
  mcpServerInspectionSchema,
  mcpServerLocatorSchema,
  mcpServerSourceSchema,
  mcpServerTestResultSchema,
  mcpServerTestTargetSchema,
} from '../src/contract/global/mcpManagement.js';
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

type AssertEngineToWire<TSchema extends z.ZodType, TEngine> = [MutableDeep<TEngine>] extends [
  z.infer<TSchema>,
]
  ? true
  : never;

type AssertWireToEngine<TSchema extends z.ZodType, TEngine> = [z.infer<TSchema>] extends [
  MutableDeep<TEngine>,
]
  ? true
  : never;

const _registryImportOptions: AssertWire<
  typeof importCustomRegistryOptionsSchema, ImportCustomRegistryOptions
> = true;
const _registryImportResult: AssertWire<
  typeof importCustomRegistryResultSchema, ImportCustomRegistryResult
> = true;

type OAuthFlowStart = Awaited<ReturnType<IOAuthService['startLogin']>>;
type OAuthFlowSnapshot = NonNullable<ReturnType<IOAuthService['getFlow']>>;
type OAuthLoginCancelResponse = Awaited<ReturnType<IOAuthService['cancelLogin']>>;
type OAuthLogoutResponse = Awaited<ReturnType<IOAuthService['logout']>>;
type RefreshOAuthProviderModelsResponse = Awaited<
  ReturnType<IOAuthService['refreshOAuthProviderModels']>
>;
type ConfigTargetValues = `${ConfigTarget}`;

const _sessionSummary: AssertWire<typeof sessionSummarySchema, SessionSummary> = true;
const _sessionListQuery: AssertWire<typeof sessionListQuerySchema, SessionListQuery> = true;

const _workspace: AssertWire<typeof workspaceSchema, Workspace> = true;
const _workspaceUpdate: AssertWire<typeof workspaceUpdateSchema, WorkspaceUpdate> = true;

const _configInspectValue: AssertEngineToWire<typeof configInspectValueSchema, ConfigInspectValue> =
  true;
const _configDiagnostic: AssertWire<typeof configDiagnosticSchema, ConfigDiagnostic> = true;
const _configTarget: AssertWire<typeof configTargetSchema, ConfigTargetValues> = true;

const _capabilityStep: AssertWire<typeof capabilityStepSchema, CapabilityStep> = true;
const _capabilityInstallProgress: AssertWire<
  typeof capabilityInstallProgressSchema,
  CapabilityInstallProgress
> = true;
const _capabilityStatus: AssertWire<typeof capabilityStatusSchema, CapabilityStatus> = true;

const _providerConfig: AssertWire<typeof providerConfigSchema, ProviderConfig> = true;

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

const _experimentalFeatureState: AssertWire<
  typeof experimentalFeatureStateSchema,
  ExperimentalFeatureState
> = true;

const _fsBrowseResponse: AssertWire<typeof fsBrowseResponseSchema, FsBrowseResponse> = true;
const _fsHomeResponse: AssertWire<typeof fsHomeResponseSchema, FsHomeResponse> = true;

const _fileMeta: AssertWire<typeof fileMetaSchema, FileMeta> = true;
const _fileSaveOptions: AssertWire<typeof fileSaveOptionsSchema, SaveOptions> = true;

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

const _modelConfig: AssertWire<typeof modelConfigSchema, ModelRecord> = true;

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

const _mcpServerSource: AssertWire<typeof mcpServerSourceSchema, McpServerSource> = true;
const _mcpRegistryPluginOrigin: AssertWire<
  typeof mcpRegistryPluginOriginSchema,
  McpRegistryPluginOrigin
> = true;
const _mcpRegistryQuery: AssertWire<typeof mcpRegistryQuerySchema, McpRegistryQuery> = true;
const _mcpAuthStatusQuery: AssertWire<typeof mcpAuthStatusQuerySchema, McpAuthStatusQuery> = true;
const _globalMcpServerConfig: AssertWire<
  typeof globalMcpServerConfigSchema,
  GlobalMcpServerConfig
> = true;
const _mcpServerConfigData: AssertWire<
  typeof mcpServerConfigDataSchema,
  McpServerConfig | McpServerConfigView
> = true;
const _mcpServerConfigViewData: AssertWire<
  typeof mcpServerConfigDataSchema,
  McpServerConfigView
> = true;
const _mcpManagedServer: AssertWire<typeof mcpManagedServerSchema, McpManagedServer> = true;
const _mcpServerTestTarget: AssertWire<typeof mcpServerTestTargetSchema, McpServerTestTarget> =
  true;
const _mcpServerTestResult: AssertWire<typeof mcpServerTestResultSchema, McpServerTestResult> =
  true;
const _mcpServerLocator: AssertWire<typeof mcpServerLocatorSchema, McpServerLocator> = true;
const _mcpServerAuthState: AssertWire<typeof mcpServerAuthStateSchema, McpServerAuthState> = true;
const _mcpServerInspection: AssertWire<typeof mcpServerInspectionSchema, McpServerInspection> =
  true;
const _mcpServerAuthStatus: AssertWire<typeof mcpServerAuthStatusSchema, McpServerAuthStatus> =
  true;
const _mcpServerAuthBeginResult: AssertWire<
  typeof mcpServerAuthBeginResultSchema,
  McpServerAuthBeginResult
> = true;
const _mcpServerAuthFlowHandle: AssertWire<
  typeof mcpServerAuthFlowHandleSchema,
  McpServerAuthFlowHandle
> = true;

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

const _sessionMeta: AssertWire<typeof sessionMetaSchema, SessionMeta> = true;
const _agentMeta: AssertWire<typeof agentMetaSchema, AgentMeta> = true;
const _sessionMetaPatch: AssertWire<typeof sessionMetaPatchSchema, SessionMetaPatch> = true;
const _sessionMetadataChangedEvent: AssertWire<
  typeof sessionMetadataChangedEventSchema,
  SessionMetadataChangedEvent
> = true;

const _createSessionOptions: AssertWire<typeof createSessionOptionsSchema, CreateSessionOptions> =
  true;
const _forkSessionOptions: AssertWire<typeof forkSessionOptionsSchema, ForkSessionOptions> = true;
const _resumeSessionOptions: AssertWire<typeof resumeSessionOptionsSchema, ResumeSessionOptions> =
  true;
const _createChildSessionOptions: AssertWire<
  typeof createChildSessionOptionsSchema,
  CreateChildSessionOptions
> = true;
const _handleWire: AssertEngineToWire<typeof handleWireSchema, ISessionScopeHandle> = true;

const _interaction: AssertWire<typeof interactionSchema, Interaction> = true;
const _interactionResolution: AssertWire<
  typeof interactionResolutionSchema,
  InteractionResolution
> = true;

const _approvalRequest: AssertEngineToWire<typeof approvalRequestSchema, ApprovalRequest> = true;
const _approvalResponse: AssertWire<typeof approvalResponseSchema, ApprovalResponse> = true;

const _questionRequest: AssertWire<typeof questionRequestSchema, QuestionRequest> = true;
const _questionItem: AssertWire<typeof questionItemSchema, QuestionItem> = true;
const _questionOption: AssertWire<typeof questionOptionSchema, QuestionOption> = true;
const _questionAnswers: AssertWire<typeof questionAnswersSchema, QuestionAnswers> = true;
const _questionResponse: AssertWire<typeof questionResponseSchema, QuestionResponse> = true;
const _questionResult: AssertWire<typeof questionResultSchema, QuestionResult> = true;

const _skillSummary: AssertWire<typeof skillSummarySchema, SkillSummary> = true;

const _generateTitleOutput: AssertWire<
  (typeof sessionTitleContract)['generateTitle']['output'],
  Awaited<ReturnType<ISessionTitleService['generateTitle']>>
> = true;

const _sessionActivityState: AssertWire<typeof sessionActivityStateSchema, SessionActivityState> =
  true;

type ActivateSkillPayload = Parameters<IAgentSkillService['activate']>[0];
type PromptWithSkillsPayload = Parameters<IAgentSkillService['promptWithSkills']>[0];
type PromptSkillActivation = PromptWithSkillsPayload['skills'][number];
type AgentCommandInfo = ReturnType<IAgentCommandService['list']>[number];
type RuntimeBinding = ReturnType<IAgentRuntimeBindingService['get']>;
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
const _promptPayload: AssertWireToEngine<typeof promptPayloadSchema, PromptPayload> = true;
const _promptSkillActivation: AssertWire<
  typeof promptSkillActivationSchema,
  PromptSkillActivation
> = true;
const _promptWithSkillsPayload: AssertWireToEngine<
  typeof promptWithSkillsPayloadSchema,
  PromptWithSkillsPayload
> = true;
const _steerPayload: AssertWireToEngine<typeof steerPayloadSchema, SteerPayload> = true;
const _activateSkillPayload: AssertWire<typeof activateSkillPayloadSchema, ActivateSkillPayload> =
  true;
const _promptLaunchResult: AssertWire<typeof promptLaunchResultSchema, PromptLaunchResult> = true;
type PromptWithSkillsResult = Awaited<ReturnType<IAgentSkillService['promptWithSkills']>>;
const _promptWithSkillsResult: AssertWire<
  typeof promptWithSkillsResultSchema,
  PromptWithSkillsResult
> = true;
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
const _agentContextData: AssertEngineToWire<typeof agentContextDataSchema, AgentContextData> = true;
const _agentCommandInfo: AssertWire<typeof agentCommandInfoSchema, AgentCommandInfo> = true;
const _runtimeBinding: AssertWire<typeof runtimeBindingSchema, RuntimeBinding> = true;
const _runCommandPayload: AssertWire<typeof runCommandPayloadSchema, RunCommandPayload> = true;
const _planData: AssertWire<typeof planDataSchema, PlanData> = true;
const _cancelPlanPayload: AssertWire<typeof cancelPlanPayloadSchema, CancelPlanPayload> = true;
const _getTasksPayload: AssertWire<typeof getTasksPayloadSchema, GetTasksPayload> = true;
const _agentTaskInfo: AssertWire<typeof agentTaskInfoSchema, TaskInfo> = true;
const _stopTaskPayload: AssertWire<typeof stopTaskPayloadSchema, StopTaskPayload> = true;
const _getTaskOutputPayload: AssertWire<typeof getTaskOutputPayloadSchema, GetTaskOutputPayload> =
  true;

const _mcpServerEntry: AssertWire<typeof mcpServerEntrySchema, McpServerEntry> = true;
const _fullCompactionInput: AssertWire<typeof fullCompactionInputSchema, FullCompactionInput> =
  true;

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
