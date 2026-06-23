export * from './agent';
export * from './session';
export * from './rpc';
export * from './config';
export * from './flags';
export * from './session/export';
export * from './telemetry';
export * from './errors';
export * from './plugin';
export { buildReplay } from './agent/replay/build';
export {
  flushDiagnosticLogs,
  getRootLogger,
  log,
  redact,
  resolveGlobalLogPath,
  resolveLoggingConfig,
} from './_base/logging';
export { installGlobalProxyDispatcher } from './_utils/net';
export type {
  LogContext,
  LogEntry,
  LogLevel,
  LogPayload,
  Logger,
  LoggingConfig,
  ResolveLoggingInput,
  RootLogger,
  SessionAttachInput,
  SessionLogHandle,
} from './_base/logging';
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
export * from './_base/di';

// ─── Base — unexpected-error reporting ─────────────────────────────────────
// `onUnexpectedError` / `safelyCallListener` / `setUnexpectedErrorHandler` /
// `resetUnexpectedErrorHandler` / `UnexpectedErrorHandler` were historically
// re-exported via `./errors`; they now live in `_base/errors`. Re-exporting
// here keeps the package root surface unchanged for consumers like `server`.
export * from './_base/errors';

// ─── Approval contract (di-v3) ─────────────────────────────────────────────
// keeps package root surface unchanged for server
export * from './approval';

// ─── Scope mechanism (di-v3) ───────────────────────────────────────────────
// Exposes `LifecycleScope`, `registerScopedService` /
// `getScopedServiceDescriptors` / `markBuilt` / `isBuilt`, the `I*Context`
// identity decorators, `IScopeHandle` / `IServiceAccessor`, the
// `ScopeBuilder` family, and the manager-pattern base/contracts. The scope
// barrel is explicit and its names do not collide with the rest of this
// top-level surface (verified before re-exporting), so a wildcard re-export
// is safe here.
export * from './scope';

// ─── Base — Event<T> / Emitter<T> ──────────────────────────────────────────
// NOTE: only `Emitter` is re-exported from the top-level barrel — the new
// VSCode-style `Event<T>` symbol collides with `./rpc`'s `Event` (agent-core
// protocol Event union, exported via `export * from './rpc'` above). Callers
// that need the emitter `Event<T>` type import it from the explicit sub-path
// `@moonshot-ai/agent-core/_base/event` (declared in `package.json`
// `exports`). This keeps the existing top-level `Event` semantics stable for
// consumers like `services/src/event/event.ts` while letting new code reach
// for the emitter type without naming clashes.
export { Emitter } from './_base/event';

// ─── In-process services (merged from @moonshot-ai/services) ─────────────────
// Re-exports the `IXxxService` contracts, default `XxxService` implementations,
// `toProtocol*` translators and error classes. Importing this barrel triggers
// the `registerSingleton(...)` side-effects at the bottom of each `*Service.ts`,
// populating the DI registry consumed by `getSingletonServiceDescriptors()`.
//
// NOTE: `ApprovalRequest` / `ApprovalResponse` / `QuestionRequest` /
// `QuestionResult` are intentionally NOT re-exported here — they are the
// canonical protocol shapes already exported via `./rpc` (`rpc/sdk-api.ts`),
// and re-exporting them again would collide (TS2308).
export * from './services';
