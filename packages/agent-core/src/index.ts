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
export { installGlobalProxyDispatcher } from './utils/proxy';
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
  AgentBackgroundTaskInfo,
  BackgroundTaskInfo,
  BackgroundTaskStatus,
  ProcessBackgroundTaskInfo,
  QuestionBackgroundTaskInfo,
} from './agent/background';
export type { ToolServices } from './tools/support/services';
export { SingleModelProvider } from './session/provider-manager';
export type {
  BearerTokenProvider,
  ModelProvider,
  OAuthTokenProviderResolver,
  ResolvedRuntimeProvider,
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

// ─── Dependency injection container ────────────────────────────────────────
export * from './di';

// ─── Base — Event<T> / Emitter<T> ──────────────────────────────────────────
// NOTE: only `Emitter` is re-exported from the top-level barrel — the new
// VSCode-style `Event<T>` symbol collides with `./rpc`'s `Event` (agent-core
// protocol Event union, exported via `export * from './rpc'` above). Callers
// that need the emitter `Event<T>` type import it from the explicit sub-path
// `@moonshot-ai/agent-core/base/common/event` (declared in `package.json`
// `exports`). This keeps the existing top-level `Event` semantics stable for
// consumers like `services/src/event/event.ts` while letting new code reach
// for the emitter type without naming clashes.
export { Emitter } from './base/common/event';
