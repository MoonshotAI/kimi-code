import { DEFAULT_OAUTH_PROVIDER_NAME } from '#/constant/app';
import { t } from '#/i18n';

export { DEFAULT_OAUTH_PROVIDER_NAME, OAUTH_LOGIN_REQUIRED_CODE, PRODUCT_NAME } from '#/constant/app';

export function getLlmNotSetMessage(): string {
  return t('tui.chrome.hints.llmNotSet');
}
export function getNoActiveSessionMessage(): string {
  return t('tui.chrome.hints.noActiveSession');
}
export function getCtrlDHint(): string {
  return t('tui.chrome.hints.ctrlDExit');
}
export function getCtrlCHint(): string {
  return t('tui.chrome.hints.ctrlCExit');
}
export const MAIN_AGENT_ID = 'main';
export function getOauthLoginRequiredStartupNotice(): string {
  return t('tui.chrome.hints.oauthLoginExpired');
}
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
