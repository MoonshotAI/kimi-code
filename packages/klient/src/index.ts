/**
 * `@moonshot-ai/klient` public surface — the transport-agnostic client facade
 * over the agent-core-v2 engine. Create a klient with one of the transport
 * entry points (`@moonshot-ai/klient/ipc` or `/memory`); everything
 * exported here behaves identically regardless of which one carried the
 * bytes.
 */

export type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from './core/channel.js';
export { RPCError } from './core/errors.js';
export { KlientValidationError, type ValidationPhase } from './core/validation.js';
export {
  createKlientFromChannel,
  type AgentHandle,
  type Klient,
  type KlientOptions,
  type SessionHandle,
} from './core/klient.js';
export type { KlientEvents } from './core/events/hub.js';
export type { Caller, ScopedCaller, ScopedStreamCaller } from './core/facade/global.js';

export type {
  ConfigTargetLiteral,
  FileDownload,
  GlobalAuthFacade,
  GlobalConfigFacade,
  GlobalFacade,
  GlobalFilesFacade,
  GlobalFlagsFacade,
  GlobalHostFsFacade,
  GlobalKosongFacade,
  GlobalPluginsFacade,
  GlobalSessionsFacade,
  GlobalWorkspacesFacade,
  KlientEnvInfo,
  ModelCatalogItem,
  OAuthFlowSnapshot,
  OAuthFlowStart,
  OAuthLoginCancelResponse,
  OAuthLogoutResponse,
  ProviderCatalogItem,
  RefreshProviderModelsOptions,
  RefreshProviderModelsResponse,
  SetDefaultModelResponse,
} from './core/facade/global.js';

export type {
  AnonymousProviderInput,
  GenerateEvent,
  GenerateInput,
  GenerateParams,
  ProviderAuth,
  ProviderInput,
} from './core/facade/kosong-types.js';

export type {
  SessionApprovalsFacade,
  SessionFacade,
  SessionInteractionsFacade,
  SessionQuestionsFacade,
  SessionRestoreOptions,
  SessionSkillsFacade,
  SessionStatus,
} from './core/facade/session.js';
export type {
  AgentCommandInfo,
  AgentContextData,
  AgentFacade,
  AgentTaskInfo,
  McpServerEntry,
  PlanData,
  PromptLaunchResult,
  PromptWithSkillsInput,
  PromptWithSkillsResult,
  SetModelResult,
  ShellCommandResult,
  ThinkingLevel,
  UsageStatus,
} from './core/facade/agent.js';

export type {
  CatalogChangedPayload,
  KlientEventName,
  KlientEventPayloads,
  SessionArchivedPayload,
  SessionMetaUpdatedPayload,
} from './contract/global/events.js';
export type { SessionEventPayloads } from './contract/session/events.js';
export type { AgentEventPayloads } from './contract/agent/events.js';

// Wire types re-exported for consumer convenience (type-only; the engine is
// not pulled in at runtime for http consumers).
export type {
  SessionListQuery,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
export type { Page } from '@moonshot-ai/agent-core-v2/persistence/interface/queryStore';
export type {
  Workspace,
  WorkspaceUpdate,
} from '@moonshot-ai/agent-core-v2/app/workspace/workspace';
export type {
  ConfigDiagnostic,
  ConfigInspectValue,
} from '@moonshot-ai/agent-core-v2/app/config/config';
export type { ProviderConfig } from '@moonshot-ai/agent-core-v2/kosong/provider/provider';
export type { AuthStatus } from '@moonshot-ai/agent-core-v2/app/auth/auth';
export type { ExperimentalFeatureState } from '@moonshot-ai/agent-core-v2/app/flag/flag';
export type {
  FsBrowseResponse,
  FsHomeResponse,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
export type { FileMeta } from '@moonshot-ai/agent-core-v2/app/file/fileService';
export type {
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from '@moonshot-ai/agent-core-v2/app/plugin/types';
export type {
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
} from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';
export type {
  ApprovalRequest,
  ApprovalResponse,
} from '@moonshot-ai/agent-core-v2/session/approval/approval';
export type {
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core-v2/session/question/question';
export type {
  Interaction,
  InteractionKind,
} from '@moonshot-ai/agent-core-v2/session/interaction/interaction';
export type { SkillSummary } from '@moonshot-ai/agent-core-v2/app/skillCatalog/types';
export type { ContentPart } from '@moonshot-ai/agent-core-v2/kosong/contract/message';
export type { PermissionMode } from '@moonshot-ai/agent-core-v2/agent/permissionPolicy/types';
