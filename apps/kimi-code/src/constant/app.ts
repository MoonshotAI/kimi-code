import { ErrorCodes } from '@moonshot-ai/kimi-code-sdk';

export const PRODUCT_NAME = 'Kimi Code';
export const CLI_COMMAND_NAME = 'kimi';
export const PROCESS_NAME = 'kimi-code';

// Used in telemetry app names and HTTP User-Agent headers.
export const CLI_USER_AGENT_PRODUCT = 'kimi-code-cli';
export const CLI_UI_MODE = 'shell';

// Give telemetry a short flush window without making CLI exit feel stuck.
export const CLI_SHUTDOWN_TIMEOUT_MS = 3000;

// Published npm package name; this can differ from the executable command.
export const NPM_PACKAGE_NAME = '@moonshot-ai/kimi-code';

// App-owned data paths. SDK/core runtime config is intentionally not routed here.
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
export const KIMI_CODE_INPUT_HISTORY_DIR_NAME = 'user-history';
export const KIMI_CODE_BANNER_DIR_NAME = 'banner';
export const KIMI_CODE_BANNER_STATE_FILE_NAME = 'state.json';

// Managed Kimi auth provider key shared with OAuth/SDK config.
export const DEFAULT_OAUTH_PROVIDER_NAME = 'managed:kimi-code';

// SDK/core error code that tells the TUI to show a login-required startup
// notice. Derived from sdk's ErrorCodes so a future rename in core
// auto-propagates instead of silently breaking the startup recovery path.
export const OAUTH_LOGIN_REQUIRED_CODE = ErrorCodes.AUTH_LOGIN_REQUIRED;

export const FEEDBACK_ISSUE_URL = 'https://github.com/MoonshotAI/kimi-code/issues';

// Sent in the feedback `version` field so the backend can distinguish this
// TypeScript client from clients that send a bare version.
export const FEEDBACK_VERSION_PREFIX = 'kimi-code-';

// Telemetry event name; keep stable for dashboard queries.
export const FEEDBACK_TELEMETRY_EVENT = 'feedback_submitted';

// CDN source of truth: all version checks and native install scripts pull from here.
export const KIMI_CODE_CDN_BASE = 'https://code.kimi.com/kimi-code';
export const KIMI_CODE_CDN_LATEST_URL = `${KIMI_CODE_CDN_BASE}/latest`;
// Rollout manifest consumed by update checks; the plain-text `/latest` above
// stays unchanged forever — already-shipped clients hard-fail on non-semver
// bodies, and the CDN install scripts read it for fresh installs.
export const KIMI_CODE_CDN_LATEST_JSON_URL = `${KIMI_CODE_CDN_BASE}/latest.json`;
export const KIMI_CODE_TIPS_BANNER_URL = 'https://cdn.kimi.com/kimi-code-tips/tips.json';
export const KIMI_CODE_PLUGIN_MARKETPLACE_URL = `${KIMI_CODE_CDN_BASE}/plugins/marketplace.json`;
export const KIMI_CODE_PLUGIN_MARKETPLACE_URL_ENV = 'KIMI_CODE_PLUGIN_MARKETPLACE_URL';
export const KIMI_CODE_INSTALL_SH_URL = `${KIMI_CODE_CDN_BASE}/install.sh`;
export const KIMI_CODE_INSTALL_PS1_URL = `${KIMI_CODE_CDN_BASE}/install.ps1`;

// Native install commands, split by platform. Use these for prompt copy and spawn calls only; do not assemble the strings elsewhere.
export const NATIVE_INSTALL_COMMAND_UNIX = `curl -fsSL ${KIMI_CODE_INSTALL_SH_URL} | bash`;
export const NATIVE_INSTALL_COMMAND_WIN = `irm ${KIMI_CODE_INSTALL_PS1_URL} | iex`;
