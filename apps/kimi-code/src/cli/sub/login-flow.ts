/**
 * Shared device-code login flow used by both `kimi login` (top-level
 * subcommand) and `kimi acp --login` (the first-class ACP terminal-auth
 * entry point). Exiting the process is part of the contract — callers
 * MUST treat the returned promise as `Promise<never>`.
 *
 * The flow runs against the local managed kimi-code login (`login-local.ts`,
 * ported from the SDK `KimiAuthFacade.login` device flow) and prints the
 * device code / verification URL to stderr before opening the browser.
 */

import { createKimiCodeHostIdentity } from '#/cli/version';
import { t } from '#/i18n';
import { openUrl } from '#/utils/open-url';

import { managedKimiLogin } from './login-local';

export async function runLoginFlow(): Promise<never> {
  const identity = createKimiCodeHostIdentity();
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    const result = await managedKimiLogin({
      identity,
      signal: controller.signal,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
        process.stderr.write(
          [
            '',
            t('tui.statusMessages.loginOpeningBrowser', { url }),
            t('tui.statusMessages.loginPasteUrl', { code: data.userCode }),
            data.expiresIn !== null && data.expiresIn !== undefined
              ? t('tui.statusMessages.loginCodeExpires', { seconds: data.expiresIn })
              : undefined,
            t('tui.statusMessages.loginWaiting'),
            '',
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        );
        try {
          openUrl(url);
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    process.stderr.write(t('tui.statusMessages.loginSuccess', { provider: result.providerName }) + '\n');
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write(t('tui.statusMessages.loginCancelled') + '\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(t('tui.statusMessages.loginFailedMsg', { message }) + '\n');
    }
    process.exit(1);
  }
}
