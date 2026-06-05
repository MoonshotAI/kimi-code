/**
 * Shared device-code login flow used by both `kimi login` (top-level
 * subcommand) and `kimi acp --login` (the first-class ACP terminal-auth
 * entry point). Exiting the process is part of the contract — callers
 * MUST treat the returned promise as `Promise<never>`.
 */

import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import { createKimiCodeHostIdentity } from '#/cli/version';
import { openUrl } from '#/utils/open-url';

export async function runLoginFlow(): Promise<never> {
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  try {
    const result = await harness.auth.login(undefined, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Best-effort: try to open the user's default browser at the
        // pre-baked URL (which already embeds the user code). Print the
        // URL + code as a fallback for headless boxes / when openUrl
        // silently fails (it `execFile`s `open`/`xdg-open`/`cmd start`
        // with no error handling — see `utils/open-url.ts`).
        openUrl(url);
        process.stderr.write(
          [
            '',
            `Opening browser for Kimi device login: ${url}`,
            `If the browser did not open, paste the URL above and enter code: ${data.userCode}`,
            data.expiresIn !== null && data.expiresIn !== undefined
              ? `Code expires in ${data.expiresIn}s.`
              : undefined,
            'Waiting for authorization to complete...',
            '',
          ]
            .filter((line): line is string => line !== undefined)
            .join('\n'),
        );
      },
    });
    process.stderr.write(`Logged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (err) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}
