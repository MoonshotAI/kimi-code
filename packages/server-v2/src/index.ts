/**
 * `@moonshot-ai/server-v2` public surface — the Kimi Code server backed by the
 * DI × Scope agent engine (`@moonshot-ai/agent-core-v2`).
 */

export { startServer, ServerLockedError } from './start';
export type { ServerStartOptions, RunningServer } from './start';
export { okEnvelope, errEnvelope } from './envelope';
export type { Envelope } from './envelope';
export { classify } from './security/bindClassify';
export type { BindClass } from './security/bindClassify';
export { rotateServerToken, serverTokenPath } from './services/auth/persistentToken';
export { createServerLogger } from './services/pinoLoggerService';
export type {
  CreateLoggerOptions,
  ServerLogger,
  ServerLogLevel,
} from './services/pinoLoggerService';
export { acquireLock, getLiveLock, DEFAULT_LOCK_PATH, DEFAULT_LOCK_DIR } from './lock';
export type { AcquireLockOptions, AcquireLockResult, LockContents } from './lock';
