export { startServer, ServerLockedError } from './start';
export type { ServerStartOptions, RunningServer } from './start';
export { okEnvelope, errEnvelope } from './envelope';
export type { Envelope } from './envelope';
export { classify } from './services/auth/bindClassify';
export type { BindClass } from './services/auth/bindClassify';
export { rotateServerToken, serverTokenPath } from './services/auth/persistentToken';
export { createServerLogger } from './services/pinoLoggerService';
export type {
  CreateLoggerOptions,
  ServerLogger,
  ServerLogLevel,
} from './services/pinoLoggerService';
export { acquireLock, getLiveLock, DEFAULT_LOCK_PATH, DEFAULT_LOCK_DIR } from './lock';
export type { AcquireLockOptions, AcquireLockResult, LockContents } from './lock';

export { resolveServiceManager, ServiceUnavailableError, ServiceUnsupportedError } from './svc';
export type {
  InstallArgs,
  InstallResult,
  LifecycleResult,
  ServiceManager,
  ServiceStatus,
} from './svc';

export { IRestGateway } from '#/services/gateway';
export { IConnectionRegistry } from '#/services/gateway';
export { ISessionClientsService } from '#/services/gateway';
export { IServerShutdownService } from '#/services/gateway';
export { IWSGateway } from '#/services/gateway';
export { IWSBroadcastService } from '#/services/gateway';

export {
  IEventService,
  IApprovalService,
  IQuestionService,
  ICoreProcessService,
  ILogService,
  IModelCatalogService,
  ISessionService,
  SessionNotFoundError,
} from '@moonshot-ai/agent-core';
