export { KimiHarness } from '#/kimi-harness';
export type { KimiHarnessRuntimeOptions } from '#/kimi-harness';
export { Session } from '#/session';
export { KimiAuthFacade } from '#/auth';
export {
  createKimiHarness,
  SDKRpcClientV2,
  type SDKRpcClientV2Options,
} from '#/sdk-rpc-client-v2';
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
export { removeProviderFromConfig } from '#/v2/config-mapper';

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
} from '#/errors';

export {
  flushDiagnosticLogs,
  flushDiagnosticLogsSync,
  log,
  redact,
  resolveGlobalLogPath,
} from '#/logging/index';
export { resolveKimiHome } from '@moonshot-ai/agent-core-v2';
export type { LogContext, LogLevel, LogPayload, Logger } from '#/logging/index';

export { effectiveModelAlias, loadRuntimeConfigSafe } from '#/config/index';
export { resolveConfigPath } from '@moonshot-ai/agent-core-v2';
export { limitAgentReplayByTurns } from '#/replay';
export { parseAgentFileText, resolveAgentPath } from '@moonshot-ai/agent-core-v2';
export { SECONDARY_DERIVED_MODEL_ALIAS } from '#/config/index';
export { PRIMARY_SUBAGENT_MODEL_CHOICE } from '@moonshot-ai/agent-core-v2/session/subagent/configSection';

export { installGlobalProxyDispatcher } from '#/proxy';

export {
  buildImageCompressionCaption,
  buildUnsupportedImageNotice,
  gateImageFormatParts,
  isModelAcceptedImageMime,
  normalizeImageMime,
  parseImageDataUrl,
  persistOriginalImage,
  sessionMediaOriginalsDir,
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_EDGE_PX,
} from '@moonshot-ai/agent-core-v2';
export { compressBase64ForModel, compressImageForModel, ImageLimits } from '#/image';
export type {
  CompressImageOptions,
  CompressImageResult,
  CompressBase64Result,
  ImageCompressionCaptionInput,
  ImageCompressionTelemetry,
} from '#/image';

export type {
  ExperimentalFeatureState,
  ExperimentalFlagMap,
  ExperimentalFlagSource,
  FlagDefinition,
  FlagDefinitionInput,
  FlagId,
  FlagSurface,
} from '#/flag';

export {
  buildDaemonFileUrl,
  buildMediaPathTag,
  isDaemonFileUrl,
  matchSingleMediaPathTag,
  parseDaemonFileUrl,
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';
export type {
  DaemonFileRef,
  MediaKind,
} from '@moonshot-ai/agent-core-v2/agent/media/mediaRef';

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
