export {
  DeviceCodeExpiredError,
  DeviceCodeTimeoutError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';

export type {
  DeviceAuthorization,
  DeviceHeaders,
  OAuthFlowConfig,
  OAuthStorageBackend,
  TokenInfo,
  TokenInfoWire,
} from './types';
export { tokenFromWire, tokenToWire } from './types';

export type { TokenStorage } from './storage';
export { FileTokenStorage } from './storage';

export type { DevicePollResult, RefreshOptions } from './oauth';
export { pollDeviceToken, refreshAccessToken, requestDeviceAuthorization } from './oauth';

export type { LoginOptions, OAuthManagerOptions, OAuthRefreshOutcome } from './oauth-manager';
export { OAuthManager, defaultRefreshThreshold, newInstanceId } from './oauth-manager';

export {
  assertKimiHostIdentity,
  createKimiDefaultHeaders,
  createKimiDeviceHeaders,
  createKimiDeviceId,
  createKimiUserAgent,
  KIMI_CODE_PLATFORM,
} from './identity';
export type { KimiHostIdentity, KimiIdentityOptions } from './identity';

export { KIMI_CODE_FLOW_CONFIG } from './constants';

export {
  applyManagedKimiCodeLogoutConfig,
  applyManagedKimiCodeConfig,
  clearManagedKimiCodeConfig,
  fetchManagedKimiCodeModels,
  kimiCodeEnvBaseUrl,
  kimiCodeEnvOAuthHost,
  KIMI_CODE_OAUTH_KEY,
  KIMI_CODE_PLATFORM_ID,
  KIMI_CODE_PROVIDER_NAME,
  ManagedKimiCodeModelsAuthError,
  provisionManagedKimiCodeConfig,
  resolveKimiCodeLoginAuth,
  resolveKimiCodeOAuthKey,
  resolveKimiCodeOAuthRef,
  resolveKimiCodeRuntimeAuth,
} from './managed-kimi-code';
export type {
  FetchManagedKimiCodeModelsOptions,
  ManagedKimiCodeApplyResult,
  ManagedKimiCodeCleanupResult,
  ManagedKimiEnv,
  ManagedKimiLoginAuth,
  ManagedKimiCodeModelInfo,
  ManagedKimiCodeProvisionResult,
  ManagedKimiConfigAdapter,
  ManagedKimiConfigShape,
  ManagedKimiOAuthRef,
  ManagedKimiOAuthRefInput,
  ManagedKimiRuntimeAuth,
  ProvisionManagedKimiCodeConfigOptions,
} from './managed-kimi-code';

export {
  fetchManagedUsage,
  formatDuration,
  formatResetTime,
  isManagedKimiCode,
  kimiCodeBaseUrl,
  kimiCodeUsageUrl,
  parseManagedUsagePayload,
} from './managed-usage';
export type {
  FetchManagedUsageError,
  FetchManagedUsageResult,
  ParsedManagedUsage,
  UsageRow,
} from './managed-usage';

export { fetchSubmitFeedback, kimiCodeFeedbackUrl } from './managed-feedback';
export type {
  FetchSubmitFeedbackError,
  FetchSubmitFeedbackOk,
  FetchSubmitFeedbackResult,
  SubmitFeedbackBody,
} from './managed-feedback';

export {
  applyOpenPlatformConfig,
  capabilitiesForModel,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  isOpenPlatformId,
  OPEN_PLATFORMS,
  OpenPlatformApiError,
  removeOpenPlatformConfig,
} from './open-platform';
export type {
  ApplyOpenPlatformResult,
  OpenPlatformDefinition,
} from './open-platform';

export {
  applyCustomRegistryEntries,
  applyCustomRegistryProvider,
  capabilitiesFromCustomEntry,
  CustomRegistryApiError,
  CUSTOM_REGISTRY_DEFAULT_CAPABILITIES,
  CUSTOM_REGISTRY_DEFAULT_MAX_CONTEXT,
  fetchCustomRegistry,
  removeCustomRegistryProvider,
} from './custom-registry';
export type {
  CustomRegistryModelEntry,
  CustomRegistryProviderEntry,
  CustomRegistryProviderType,
  CustomRegistrySource,
} from './custom-registry';

export { KimiOAuthToolkit, resolveKimiTokenStorageName } from './toolkit';
export type {
  AuthManagedUsageResult,
  AuthProviderStatus,
  AuthStatus,
  BearerTokenProvider,
  KimiOAuthLoginOptions,
  KimiOAuthLoginResult,
  KimiOAuthLogoutResult,
  KimiOAuthTokenRef,
  KimiOAuthToolkitOptions,
} from './toolkit';
