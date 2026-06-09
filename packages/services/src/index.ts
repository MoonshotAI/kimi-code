/**
 * `@moonshot-ai/services` — in-process service container for the kimi-code
 * daemon. Houses every `IXxxService` decorator (per-domain folder), the
 * `CoreProcessService` that owns the in-process `KimiCore` instance, and the
 * adapters that translate `KimiCore` shapes into protocol-shaped data.
 *
 * Naming convention is encoded in `packages/services/AGENTS.md` — every
 * injectable uses the `Service` suffix, contracts live in `<domain>.ts`,
 * impl lives in `<domain>Service.ts`, folder names are camelCase.
 *
 * Per-domain layout:
 *   coreProcess/coreProcess.ts          — ICoreProcessService + CoreProcessServiceOptions
 *   coreProcess/coreProcessService.ts   — CoreProcessService (self-registers via registerSingleton)
 *   coreProcess/coreProcessClient.ts    — BridgeClientAPI (SDK-side of the RPC pair)
 *   event/event.ts                      — IEventService
 *   event/eventService.ts               — EventService (pure in-process Emitter wrapper)
 *   approval/approval.ts                — IApprovalService + protocol adapter
 *   question/question.ts                — IQuestionService + protocol adapter
 *   environment/environment.ts          — IEnvironmentService
 *   session/session.ts                  — ISessionService + toProtocolSession
 *   session/sessionService.ts           — SessionService
 *   message/message.ts                  — IMessageService + toProtocolMessage
 *   message/messageService.ts           — MessageService
 *   prompt/prompt.ts                    — IPromptService + SyntheticPrompt* events
 *   prompt/promptService.ts             — PromptService
 *   tool/tool.ts                        — IToolService + toProtocolTool
 *   tool/toolService.ts                 — ToolService
 *   mcp/mcp.ts                          — IMcpService + toProtocolMcpServer
 *   mcp/mcpService.ts                   — McpService
 *   task/task.ts                        — ITaskService + toProtocolTask
 *   task/taskService.ts                 — TaskService
 *   oauth/oauth.ts                      — IOAuthService
 *   oauth/oauthService.ts               — OAuthService
 *   authSummary/authSummary.ts          — IAuthSummaryService + sentinel errors
 *   authSummary/authSummaryService.ts   — AuthSummaryService
 *   modelCatalog/modelCatalog.ts        — IModelCatalogService + config adapters
 *   modelCatalog/modelCatalogService.ts — ModelCatalogService
 */

export { BridgeClientAPI } from './coreProcess/coreProcessClient';
export type { CoreProcessClientDeps } from './coreProcess/coreProcessClient';
export {
  ICoreProcessService,
  type CoreProcessServiceOptions,
} from './coreProcess/coreProcess';
export { CoreProcessService } from './coreProcess/coreProcessService';
export {
  defaultServicesModule,
  type ServiceModuleEntry,
} from './module';

// --- per-domain exports ---------------------------------------------------

// event service
export { IEventService } from './event/event';
export { EventService } from './event/eventService';

// approval service + adapter
export { IApprovalService } from './approval/approval';
export type { ApprovalRequest, ApprovalResponse } from './approval/approval';
export {
  toAgentCoreResponse as approvalToAgentCoreResponse,
  toBrokerRequest as approvalToBrokerRequest,
  type ToBrokerRequestParams as ApprovalToBrokerRequestParams,
} from './approval/approval';

// question service + adapter
export { IQuestionService } from './question/question';
export type { QuestionRequest, QuestionResult } from './question/question';
export {
  toAgentCoreResponse as questionToAgentCoreResponse,
  toBrokerRequest as questionToBrokerRequest,
  dismissedResult as questionDismissedResult,
  type QuestionToBrokerRequestParams,
} from './question/question';

// environment service
export { IEnvironmentService } from './environment/environment';

// authSummary service
export {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthTokenUnauthorizedError,
  AuthModelNotResolvedError,
} from './authSummary/authSummary';
export { AuthSummaryService } from './authSummary/authSummaryService';

// oauth service
export { IOAuthService } from './oauth/oauth';
export { OAuthService } from './oauth/oauthService';

// model catalog service + adapter
export {
  IModelCatalogService,
  ModelNotFoundError,
  ProviderNotFoundError,
  modelIdsForProvider,
  toProtocolModel,
  toProtocolProvider,
} from './modelCatalog/modelCatalog';
export type { ProviderCredentialState } from './modelCatalog/modelCatalog';
export { ModelCatalogService } from './modelCatalog/modelCatalogService';

// session service + adapter
export {
  ISessionService,
  SessionNotFoundError,
  toProtocolSession,
} from './session/session';
export type { SessionListQuery } from './session/session';
export { SessionService } from './session/sessionService';

// message service + adapter
export {
  IMessageService,
  MessageNotFoundError,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from './message/message';
export type { MessageListQuery } from './message/message';
export { MessageService } from './message/messageService';

// prompt service
export {
  IPromptService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
} from './prompt/prompt';
export type {
  AgentStateSnapshot,
  PromptAbortResult,
  PromptDispatchLogEntry,
  SyntheticPromptAbortedEvent,
  SyntheticPromptCompletedEvent,
} from './prompt/prompt';
export { PromptService } from './prompt/promptService';

// tool service + adapter
export {
  IToolService,
  toProtocolTool,
  type AgentCoreToolInfoLike,
} from './tool/tool';
export { ToolService } from './tool/toolService';

// mcp service + adapter
export {
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp/mcp';
export { McpService } from './mcp/mcpService';

// task service + adapter
export {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  toProtocolTask,
  isTerminalStatus,
} from './task/task';
export type { TaskListQuery } from './task/task';
export { TaskService } from './task/taskService';

// NOTE: every `<X>Service.ts` impl file self-registers at the bottom via
// `registerSingleton(IXxx, XxxService, InstantiationType.Delayed)` (or the
// descriptor overload when a leading options bag is required, e.g.
// `CoreProcessService`). `defaultServicesModule()` is a thin projection of
// that global registry. Consumers override entries with `services.set(...)`
// for runtime static args or prebuilt instances.
