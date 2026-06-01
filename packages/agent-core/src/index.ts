export * from './agent';
export * from './session';
export * from './rpc';
export * from './config';
export * from './flags';
export * from './session/export';
export * from './telemetry';
export * from './errors';
export * from './plugin';
export {
  flushDiagnosticLogs,
  getRootLogger,
  log,
  redact,
  resolveGlobalLogPath,
} from './logging/logger';
export { resolveLoggingConfig } from './logging/resolve-config';
export type { ResolveLoggingInput } from './logging/resolve-config';
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
} from './logging/types';
export { USER_PROMPT_ORIGIN } from './agent/context';
export type {
  AgentContextData,
  ContextMessage,
  PromptOrigin,
  UserPromptOrigin,
} from './agent/context';
export type {
  BackgroundLifecycleEvent,
  BackgroundTaskInfo,
  BackgroundTaskKind,
  BackgroundTaskStatus,
} from './tools/background/manager';
export type { ToolServices } from './tools/support/services';
export { SingleModelProvider } from './session/provider-manager';
export type {
  BearerTokenProvider,
  ModelProvider,
  OAuthTokenProviderResolver,
} from './session/provider-manager';

// ─── Wire records (for in-monorepo consumers like apps/vis) ────────────────
export type {
  AgentRecord,
  AgentRecordEvents,
  AgentRecordOf,
  AgentRecordPersistence,
} from './agent/records';
export { AGENT_WIRE_PROTOCOL_VERSION } from './agent/records';
export type { AgentConfigUpdateData } from './agent/config';
export type { CompactionBeginData, CompactionResult } from './agent/compaction';
export type {
  PermissionApprovalResultRecord,
  PermissionMode,
} from './agent/permission';
export type { UsageRecordScope } from './agent/usage';
export type { ToolStoreUpdate } from './tools/store';
export type {
  LoopRecordedEvent,
  LoopStepBeginEvent,
  LoopStepEndEvent,
  LoopContentPartEvent,
  LoopToolCallEvent,
  LoopToolResultEvent,
} from './loop';
export type {
  ExecutableToolResult,
  ExecutableToolSuccessResult,
  ExecutableToolErrorResult,
} from './loop/types';
