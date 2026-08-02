export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';
export { createKimiHarness } from '#/sdk-rpc-client';
export {
  createKimiConfigRpc,
  KimiConfigRpcClient,
  type KimiConfigRpc,
  type KimiConfigValidationIssue,
  type KimiConfigValidationPathSegment,
  type ResolveKimiConfigPathInput,
  type ValidateKimiConfigTomlInput,
} from '#/config-rpc';
export { SDKRpcClientBase } from '#/rpc';
export { KimiForCodingProvider } from '#/kimi-code-model-provider';
export type { KimiForCodingProviderOptions } from '#/kimi-code-model-provider';

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
  resolveCatalogImport,
} from '#/catalog';
export type {
  ApplyCatalogProviderOptions,
  Catalog,
  CatalogImportInvalidReason,
  CatalogImportResolution,
  CatalogModel,
  CatalogProviderEntry,
  FetchCatalogOptions,
} from '#/catalog';

// Locale — forwarded from the shared i18n package (the same source the retired
// agent-core re-exported) so hosts never import @moonshot-ai/agent-core/i18n directly.
export { setLocale, getLocale } from '@moonshot-ai/kimi-i18n';
export type { Locale } from '@moonshot-ai/kimi-i18n';

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
  resolveErrorTitle,
  toKimiErrorPayload,
} from '#/legacy/errors';

// Diagnostic logging — public surface only, forwarded from the kimi-agent
// runtime shim (the retired agent-core logging implementation lives there).
export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  redact,
  resolveGlobalLogPath,
} from '@moonshot-ai/kimi-agent/runtime';
export type { LogContext, LogLevel, LogPayload, Logger } from '@moonshot-ai/kimi-agent/runtime';
export { resolveKimiHome } from '#/legacy/config';

// Host-side config helpers — safe config reader + config path resolution, used
// by hosts (e.g. the CLI's server telemetry bootstrap) that need to inspect
// config without spinning up a full KimiCore.
export { effectiveModelAlias, loadRuntimeConfigSafe, resolveConfigPath } from '#/legacy/config';
export { limitAgentReplayByTurns } from '#/legacy/replay';

// Rust engine override — hosts wire the Rust agent engine via this hook.
export type { RunTurnOverride } from '@moonshot-ai/kimi-agent/contract';

// Process-wide HTTP proxy bootstrap — installed once at CLI startup so all
// outbound fetch honors HTTP_PROXY / HTTPS_PROXY / NO_PROXY.
export { installGlobalProxyDispatcher } from '@moonshot-ai/kimi-agent/runtime';

// Image compression — ingestion sites (e.g. the CLI's clipboard paste, the ACP
// adapter) shrink oversized images while constructing the content part, before
// it enters a prompt. Best effort: returns the original on any failure.
// Compression is never silent: buildImageCompressionCaption renders the note
// placed next to a compressed image, and persistOriginalImage keeps the
// pre-compression bytes readable (ReadMediaFile + region) for detail.
// Local port of the retired agent-core image pipeline (legacy/image).
export {
  buildImageCompressionCaption,
  compressImageForModel,
  compressBase64ForModel,
  extractImageCompressionCaptions,
  gateImageFormatParts,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '#/legacy/image/image-compress';
export {
  buildUnsupportedImageNotice,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
} from '#/legacy/image/image-format-policy';
export { persistOriginalImage, sessionMediaOriginalsDir } from '#/legacy/image/image-originals';
export type { ImageLimits } from '#/kimi-harness';
export type {
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  ImageCompressionCaptionInput,
  ImageCompressionTelemetry,
} from '#/legacy/image/image-compress';

// Experimental feature flags — types only. Resolved values come from
// `KimiHarness.getExperimentalFeatures()` over RPC, not from a re-exported runtime value.
export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '#/legacy/flags';

export type {
  KimiAuthCompleteFeedbackUploadInput,
  KimiAuthCompleteFeedbackUploadPart,
  KimiAuthCreateFeedbackUploadUrlInput,
  KimiAuthCreateFeedbackUploadUrlOk,
  KimiAuthCreateFeedbackUploadUrlResult,
  KimiAuthFeedbackUploadPart,
  KimiAuthLoginResult,
  KimiAuthLogoutResult,
  KimiAuthSubmitFeedbackInput,
} from '#/auth';

export * from '#/events';
export type * from '#/types';

// ── Rust-engine session assembly (host-side, forwarded from agent-core) ──
// The session engine (print-mode pilot + TUI native sessions) assembles MCP
// servers, hooks, and the system prompt on the host. These entry points are
// forwarded so apps never import @moonshot-ai/agent-core directly.
export { loadMcpServers } from '@moonshot-ai/agent-core/mcp/config-loader';
// The schema entry type (mcp.json server entries) — aliased to avoid
// clashing with the SDK's `McpServerConfig` (= GlobalMcpServerConfig, name-keyed).
export type { McpServerConfig as McpServerConfigEntry } from '@moonshot-ai/agent-core/config/schema';
export { PluginManager } from '@moonshot-ai/agent-core/plugin/manager';
export { prepareSystemPromptContext } from '@moonshot-ai/agent-core/profile/context';
export { DEFAULT_AGENT_PROFILES } from '@moonshot-ai/agent-core/profile/default';
export type {
  AgentContextData,
  AgentReplayRecord,
  ContextMessage,
  PromptOrigin,
  ResumedAgentState,
  SwarmModeTrigger,
} from '@moonshot-ai/agent-core';
