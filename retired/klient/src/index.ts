/**
 * `@moonshot-ai/klient` public surface — the transport-agnostic client facade
 * over the Rust engine. Create a klient with the transport entry point
 * (`@moonshot-ai/klient/rust`); everything exported here behaves identically
 * regardless of which transport carried the bytes.
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
  GlobalAuthFacade,
  GlobalConfigFacade,
  GlobalFacade,
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
  SessionStatus,
} from './core/facade/session.js';
export type {
  AgentContextData,
  AgentFacade,
  AgentTaskInfo,
  PlanData,
  PromptLaunchResult,
  SetModelResult,
  ShellCommandResult,
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

// Wire types re-exported for consumer convenience (type-only). Sourced from
// `./legacy-types.js` — the frozen local mirror of the retired
// `@moonshot-ai/agent-core-v2` shapes, pinned by the compile-time parity
// assertions in `test/contract-parity.ts` — so the engine package is not a
// klient dependency and consumers get byte-identical signatures.
export type {
  SessionListQuery,
  SessionSummary,
  Page,
  Workspace,
  WorkspaceUpdate,
  ConfigDiagnostic,
  ConfigInspectValue,
  ProviderConfig,
  AuthStatus,
  ExperimentalFeatureState,
  FsBrowseResponse,
  FsHomeResponse,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
  AgentMeta,
  SessionMeta,
  SessionMetaPatch,
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
  Interaction,
  InteractionKind,
  ContentPart,
  PermissionMode,
} from './legacy-types.js';
