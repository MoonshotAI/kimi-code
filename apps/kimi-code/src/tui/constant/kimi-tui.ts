import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';

export { DEFAULT_OAUTH_PROVIDER_NAME, OAUTH_LOGIN_REQUIRED_CODE, PRODUCT_NAME } from '#/constant/app';

export const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';
export const NO_ACTIVE_SESSION_MESSAGE = 'No active session. Send /login to login.';
export const CTRL_D_HINT = 'Press Ctrl+D again to exit';
export const CTRL_C_HINT = 'Press Ctrl+C again to exit';
export const MAIN_AGENT_ID = 'main';
export const OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE = 'OAuth login expired. Send /login to login.';
export const EXIT_CONFIRM_WINDOW_MS = 1500;
// Time window for treating two consecutive Esc presses as a double-Esc, which
// opens the undo selector. Kept short (double-click feel) so two deliberate
// presses far apart don't accidentally trigger undo.
export const DOUBLE_ESC_WINDOW_MS = 600;

export function isManagedUsageProvider(
  providerKey: string | undefined,
): providerKey is typeof DEFAULT_OAUTH_PROVIDER_NAME {
  return providerKey === DEFAULT_OAUTH_PROVIDER_NAME;
}
