import { ErrorCodes, type HostUiCapability } from '@moonshot-ai/kimi-code-sdk';

import { currentKimiManagedRuntimeAuth, currentKimiProfile } from '#/utils/region';

export const PRODUCT_NAME = 'Kimi Code';
export const CLI_COMMAND_NAME = 'kimi';
export const PROCESS_NAME = 'kimi-code';

export const CLI_USER_AGENT_PRODUCT = 'kimi-code-cli';
export const CLI_MSH_PLATFORM = 'kimi_code_cli';
export const CLI_UI_MODE = 'shell';
export const TUI_HOST_UI_CAPABILITIES: readonly HostUiCapability[] = ['update_panel'];
export const WEB_UI_MODE = 'web';
export const WEB_USER_AGENT_SUFFIX = 'web';

export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

export const PROMPT_CLEANUP_TIMEOUT_MS = 8000;

export const HEADLESS_FORCE_EXIT_GRACE_MS = 2000;

export const HEADLESS_STDIO_DRAIN_TIMEOUT_MS = 10000;

export const NPM_PACKAGE_NAME = '@moonshot-ai/kimi-code';

export const KIMI_CODE_HOME_ENV = 'KIMI_CODE_HOME';
export const KIMI_CODE_DATA_DIR_NAME = '.kimi-code';
export const KIMI_CODE_LOG_DIR_NAME = 'logs';
export const KIMI_CODE_CACHE_DIR_NAME = 'cache';
export const KIMI_CODE_UPDATE_DIR_NAME = 'updates';
export const KIMI_CODE_BIN_DIR_NAME = 'bin';
export const KIMI_CODE_UPDATE_STATE_FILE_NAME = 'latest.json';
export const KIMI_CODE_UPDATE_INSTALL_STATE_FILE_NAME = 'install.json';
export const KIMI_CODE_UPDATE_INSTALL_LOCK_FILE_NAME = 'install.lock';
export const KIMI_CODE_UPDATE_ROLLOUT_LOG_FILE_NAME = 'rollout.log';
export const KIMI_CODE_PLUGIN_UPDATE_NOTICE_STATE_FILE_NAME = 'plugin-notices.json';
export const KIMI_CODE_NATIVE_STAGING_DIR_NAME = '.staging';
export const KIMI_CODE_NATIVE_STAGED_STATE_FILE_NAME = 'staged.json';
export const KIMI_CODE_UPDATE_REEXEC_ENV = 'KIMI_CODE_UPDATE_REEXEC';
export const KIMI_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const KIMI_CODE_BANNER_DIR_NAME = 'banner';
export const KIMI_CODE_BANNER_STATE_FILE_NAME = 'state.json';
export const KIMI_CODE_RECOMMENDED_EFFORT_STATE_FILE_NAME = 'recommended-effort-state.json';
export const KIMI_CODE_MODEL_MIGRATION_STATE_FILE_NAME = 'model-migrations.json';

export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:kimi-code';

export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

export const FEEDBACK_ISSUE_URL = 'https://github.com/MoonshotAI/kimi-code/issues';
export function kimiCodeSignupUrl(): string {
  return `${currentKimiProfile().siteBase}/code`;
}

export const FEEDBACK_VERSION_PREFIX = 'kimi-code-';

export const FEEDBACK_TELEMETRY_EVENT = 'feedback_submitted';

export function kimiCodeCdnBase(): string {
  return currentKimiProfile().cdnBase;
}
export function kimiCodeCdnLatestUrl(): string {
  return `${kimiCodeCdnBase()}/latest`;
}
export function kimiCodeCdnLatestJsonUrl(): string {
  return `${kimiCodeCdnBase()}/latest.json`;
}
export function kimiCodeCdnCanaryChannelUrl(): string {
  return `${kimiCodeCdnBase()}/channels/canary.json`;
}
export function kimiCodeCdnBinariesBase(): string {
  return `${kimiCodeCdnBase()}/binaries`;
}
export {
  isTrustedPluginMarketplaceUrl as isTrustedKimiCodePluginMarketplace,
  KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV,
} from '@moonshot-ai/kimi-code-sdk';
export function kimiCodePluginMarketplaceUrl(): string {
  const auth = currentKimiManagedRuntimeAuth();
  const baseUrl = (auth.baseUrl ?? currentKimiProfile().baseUrl).trim().replace(/\/+$/, '');
  return `${baseUrl}/plugins/marketplace`;
}
export const MARKETPLACE_VERSION_LOOKUP_TIMEOUT_MS = 5000;
export const INTERACTIVE_UPDATE_CHECK_TIMEOUT_MS = 10_000;
export const QUOTA_CONSUMING_PLUGIN_IDS: readonly string[] = ['kimi-datasource'];
export function kimiCodeInstallShUrl(): string {
  return `${kimiCodeCdnBase()}/install.sh`;
}
export function kimiCodeInstallPs1Url(): string {
  return `${kimiCodeCdnBase()}/install.ps1`;
}
export function kimiCodeOfficialInstallUrl(): string {
  return `${currentKimiProfile().siteBase}/code`;
}

export function nativeInstallCommandUnix(): string {
  return `curl -fsSL ${kimiCodeInstallShUrl()} | bash`;
}
export function nativeInstallCommandWin(): string {
  return `irm ${kimiCodeInstallPs1Url()} | iex`;
}
