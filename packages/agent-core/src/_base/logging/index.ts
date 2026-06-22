export type {
  LogContext,
  LogEntry,
  LogLevel,
  LogPayload,
  Logger,
  LoggingConfig,
  RootLogger,
  SessionAttachInput,
  SessionLogHandle,
} from './types';
export { LOG_LEVEL_RANK, levelEnabled } from './types';

export {
  __resetRootLoggerForTest,
  flushDiagnosticLogs,
  getRootLogger,
  log,
  redact,
  resolveGlobalLogPath,
} from './logger';

export {
  CTX_VALUE_MAX_CHARS,
  ENTRY_MAX_BYTES,
  MSG_MAX_CHARS,
  REDACT_MAX_DEPTH,
  STACK_MAX_BYTES,
  extractError,
  formatEntry,
  redactCtx,
} from './formatter';

export { resolveLoggingConfig } from './resolve-config';
export type { ResolveLoggingInput } from './resolve-config';

export { PENDING_MAX, RotatingFileSink } from './sinks';
