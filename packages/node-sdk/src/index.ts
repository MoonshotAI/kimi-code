export { KimiHarness } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';

export {
  applyCatalogProvider,
  catalogBaseUrl,
  catalogModelToAlias,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  loadBuiltInCatalog,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogModel,
  CatalogProviderEntry,
} from '#/catalog';

export {
  ErrorCodes,
  KimiError,
  type KimiErrorCode,
  type KimiErrorInfo,
  type KimiErrorOptions,
  type KimiErrorPayload,
  KIMI_ERROR_INFO,
  fromKimiErrorPayload,
  isKimiError,
  toKimiErrorPayload,
} from '@moonshot-ai/agent-core';

// Diagnostic logging — public surface only.
// RootLogger / getRootLogger / LoggingConfig stay inside agent-core.
export {
  flushDiagnosticLogs,
  log,
  redact,
  resolveGlobalLogPath,
  resolveKimiHome,
} from '@moonshot-ai/agent-core';
export type { LogContext, LogLevel, LogPayload, Logger } from '@moonshot-ai/agent-core';

// Experimental feature flags — types only. Resolved values come from
// `KimiHarness.getExperimentalFlags()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFlagMap,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '@moonshot-ai/agent-core';

export type {
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
  KimiAuthSubmitFeedbackInput,
} from '#/auth';

export * from '#/events';
export type * from '#/types';
