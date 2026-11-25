import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

export { DEFAULT_OAUTH_PROVIDER_NAME, OAUTH_LOGIN_REQUIRED_CODE, PRODUCT_NAME } from '#/constant/app';

export const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';
export const NO_ACTIVE_SESSION_MESSAGE = 'No active session. Send a message to start one.';
export const CTRL_D_HINT = 'Press Ctrl+D again to exit';
export const CTRL_C_HINT = 'Press Ctrl+C again to exit';
export const SHUTTING_DOWN_HINT = 'Shutting down… (running shutdown hooks)';
export const MAIN_AGENT_ID = 'main';
export const OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE = 'OAuth login expired. Send /login to login.';
export const ERROR_STATUS_PREFIX = 'Error: ';
export const TURN_INTERRUPTED_BY_USER_NOTICE = 'Interrupted by user';
export const PROVIDER_FILTERED_TURN_STOPPED_NOTICE =
  'Turn stopped: provider safety policy blocked the response.';
export const PROMPT_HOOK_BLOCKED_TURN_STOPPED_NOTICE =
  'Turn stopped: prompt hook blocked the request.';
export const TUI_MODE_SWITCH_BLOCKED_NOTICE =
  'Close the active view and run /reload-tui to switch TUI mode, or restart Kimi Code.';
export const SESSIONLESS_STARTUP_NOTICE =
  'No session yet — one will be created on your first message.';
export const TOWER_TEARDOWN_PROMPT =
  'Tear down the tower: call TowerTeardown and report what it did. It refuses to destroy dirty worktrees unless forced.';
export const EXIT_CONFIRM_WINDOW_MS = 1500;
export const MAX_AUTO_TITLE_ATTEMPTS = 3;
export const DOUBLE_ESC_WINDOW_MS = 600;

export const SESSION_LIST_PAGE_SIZE = 50;
export const UNDO_LIMIT_STATUS_TURN_ID = 'undo-limit-status';

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
