export { BridgeClientAPI } from './coreProcess/coreProcessClient';
export type { CoreProcessClientDeps } from './coreProcess/coreProcessClient';
export {
  ICoreProcessService,
  type CoreProcessServiceOptions,
} from './coreProcess/coreProcess';
export { CoreProcessService } from './coreProcess/coreProcessService';

export { IEventService } from './event/event';
export { EventService } from './event/eventService';

export { IApprovalService } from './approval/approval';
export type { ApprovalRequest, ApprovalResponse } from './approval/approval';
export {
  toAgentCoreResponse as approvalToAgentCoreResponse,
  toBrokerRequest as approvalToBrokerRequest,
  type ToBrokerRequestParams as ApprovalToBrokerRequestParams,
} from './approval/approval';

export { IQuestionService } from './question/question';
export type { QuestionRequest, QuestionResult } from './question/question';
export {
  toAgentCoreResponse as questionToAgentCoreResponse,
  toBrokerRequest as questionToBrokerRequest,
  dismissedResult as questionDismissedResult,
  type QuestionToBrokerRequestParams,
} from './question/question';

export { IEnvironmentService } from './environment/environment';

export { ILogService } from './logger/logger';

export {
  IFileStore,
  DEFAULT_MAX_UPLOAD_BYTES,
  FileNotFoundError,
  FileTooLargeError,
} from './fileStore/fileStore';
export type { SaveOptions, GetResult } from './fileStore/fileStore';
export { FileStore } from './fileStore/fileStoreService';

export {
  IFsService,
  FsAlreadyExistsError,
  FsPathNotFoundError,
  FsIsDirectoryError,
  FsIsBinaryError,
  FsTooLargeError,
  FsTooManyResultsError,
} from './fs/fs';
export type { FsDownloadResolved, FsPathResolved } from './fs/fs';
export { FsService } from './fs/fsService';
export {
  IFsSearchService,
  FsGrepTimeoutError,
} from './fs/fsSearch';
export { FsSearchService } from './fs/fsSearchService';
export {
  IFsGitService,
  FsGitUnavailableError,
  parsePorcelain,
  parseNumstat,
} from './fs/fsGit';
export { FsGitService } from './fs/fsGitService';
export {
  IFsWatcher,
  FsWatchLimitError,
  createConnectionLookup,
} from './fs/fsWatcher';
export type {
  FsChangedFrame,
  FsWatcherDeliverySink,
  FsWatcherConnectionLookup,
  FsWatcherServiceOptions,
} from './fs/fsWatcher';
export { FsWatcherService } from './fs/fsWatcherService';
export {
  FsPathEscapesError,
  resolveSafePath,
} from './fs/fsPathSafety';
export type { PathSafetyResult } from './fs/fsPathSafety';

export {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
} from './workspace/workspaceRegistry';
export type { WorkspacePatch } from './workspace/workspaceRegistry';
export { WorkspaceRegistryService, detectGit } from './workspace/workspaceRegistryService';
export {
  IWorkspaceFsService,
  WorkspaceFsNotAbsoluteError,
  WorkspaceFsNotFoundError,
  WorkspaceFsPermissionError,
  RECENT_ROOTS_LIMIT,
} from './workspace/workspaceFs';
export { WorkspaceFsService } from './workspace/workspaceFsService';

export {
  IAuthSummaryService,
  AuthProvisioningRequiredError,
  AuthTokenMissingError,
  AuthTokenUnauthorizedError,
  AuthModelNotResolvedError,
} from './authSummary/authSummary';
export { AuthSummaryService } from './authSummary/authSummaryService';

export { IOAuthService } from './oauth/oauth';
export { OAuthService } from './oauth/oauthService';

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

export { IConfigService } from './config/config';
export { ConfigService } from './config/configService';

export {
  ISessionService,
  SessionNotFoundError,
  SessionUndoUnavailableError,
  toProtocolSession,
} from './session/session';
export type { SessionClientTelemetry, SessionCreateOptions, SessionListQuery } from './session/session';
export { SessionService } from './session/sessionService';

export {
  IMessageService,
  MessageNotFoundError,
  deriveMessageId,
  parseMessageId,
  toProtocolMessage,
} from './message/message';
export type { MessageListQuery } from './message/message';
export { MessageService } from './message/messageService';
export {
  readWireRecords,
  readWireTranscript,
  reduceWireRecords,
} from './message/transcript';
export type { TranscriptEntry, WireTranscript } from './message/transcript';

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
  SyntheticPromptSteeredEvent,
  SyntheticPromptSubmittedEvent,
} from './prompt/prompt';
export { PromptService } from './prompt/promptService';

export {
  IToolService,
  toProtocolTool,
  type AgentCoreToolInfoLike,
} from './tool/tool';
export { ToolService } from './tool/toolService';

export {
  IMcpService,
  McpServerNotFoundError,
  toProtocolMcpServer,
} from './mcp/mcp';
export { McpService } from './mcp/mcpService';

export {
  ISkillService,
  SkillNotActivatableError,
  SkillNotFoundError,
  toProtocolSkill,
} from './skill/skill';
export { SkillService } from './skill/skillService';

export {
  ITaskService,
  TaskAlreadyFinishedError,
  TaskNotFoundError,
  toProtocolTask,
  isTerminalStatus,
} from './task/task';
export type { TaskListQuery } from './task/task';
export { TaskService } from './task/taskService';

export {
  ITerminalService,
  TerminalNotFoundError,
} from './terminal/terminal';
export type {
  TerminalAttachOptions,
  TerminalAttachSink,
  TerminalBackend,
  TerminalFrame,
  TerminalProcess,
  TerminalServiceOptions,
  TerminalSpawnOptions,
} from './terminal/terminal';
export { NodePtyTerminalBackend, TerminalService } from './terminal/terminalService';
