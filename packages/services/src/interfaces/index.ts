/**
 * Barrel for broker interfaces. Each interface pairs a TS type with a
 * `createDecorator`-built `ServiceIdentifier` value of the same name.
 *
 * Positive (daemon→harness) service interfaces (`ISessionService`, ...)
 * land here as Phase 1 chains add them. Each gets a paired impl in
 * `../impls/` plus a `defaultServicesModule()` entry.
 */

export { IEventBus } from './event-bus';
export type { } from './event-bus';
export { IApprovalBroker } from './approval-broker';
export type { ApprovalRequest, ApprovalResponse } from './approval-broker';
export { IQuestionBroker } from './question-broker';
export type { QuestionRequest, QuestionResult } from './question-broker';
export {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthTokenUnauthorizedError,
  AuthModelNotResolvedError,
} from './auth-summary-service';
export { IOAuthService } from './oauth-service';
export { ISessionService, SessionNotFoundError } from './session-service';
export type { SessionListQuery } from './session-service';
export { IMessageService, MessageNotFoundError } from './message-service';
export type { MessageListQuery } from './message-service';
export {
  IPromptService,
  PromptAlreadyCompletedError,
  PromptNotFoundError,
  SessionBusyError,
} from './prompt-service';
export type {
  IPromptLifecycleObserver,
  PromptAbortResult,
} from './prompt-service';
export { IToolService } from './tool-service';
export { IMcpService, McpServerNotFoundError } from './mcp-service';
export {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
} from './task-service';
export type { TaskListQuery } from './task-service';
