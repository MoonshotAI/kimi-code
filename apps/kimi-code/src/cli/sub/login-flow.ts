/**
 * Shared interactive authentication flow used by both `kimi login`
 * (top-level subcommand) and `kimi acp --login` (the first-class ACP
 * terminal-auth entry point).
 *
 * The login-only shell opens the same platform selector as `/login`, so
 * account OAuth and Kimi Platform API-key setup keep one implementation.
 */

import type { KimiRegion } from '@moonshot-ai/kimi-code-oauth';
import { createKimiHarness } from '@moonshot-ai/kimi-code-sdk';

import type { CLIOptions } from '#/cli/options';
import { runShell } from '#/cli/run-shell';
import { createKimiCodeHostIdentity, getVersion } from '#/cli/version';
import { openUrl } from '#/utils/open-url';

const LOGIN_CLI_OPTIONS: CLIOptions = {
  session: undefined,
  continue: false,
  yolo: false,
  auto: false,
  plan: false,
  model: undefined,
  outputFormat: undefined,
  prompt: undefined,
  skillsDirs: [],
  agent: undefined,
  agentFiles: [],
};

/** Parse a `--region` CLI flag; exits with an actionable message on bad input. */
export function parseRegionFlag(value: string): KimiRegion {
  if (value !== 'mainland-cn' && value !== 'global') {
    process.stderr.write(`Invalid --region "${value}" (expected "mainland-cn" or "global").\n`);
    process.exit(1);
  }
  return value;
}

export async function runLoginFlow(options: { region?: KimiRegion } = {}): Promise<void> {
  // When a region is requested explicitly (e.g. `kimi login --region global`
  // or ACP passes it), drive the OAuth device-code flow directly without
  // starting the full TUI. Otherwise open the same interactive selector as
  // `/login` so the user can choose OAuth vs. Kimi Platform API key.
  if (options.region !== undefined) {
    await runDirectOAuthLoginFlow(options.region);
    return;
  }

  await runShell(LOGIN_CLI_OPTIONS, getVersion(), { loginOnly: true });
}

async function runDirectOAuthLoginFlow(region: KimiRegion): Promise<never> {
  const identity = createKimiCodeHostIdentity();
  const harness = createKimiHarness({
    identity,
    uiMode: 'cli',
  });
  const controller = new AbortController();
  process.once('SIGINT', () => {
    controller.abort();
  });
  try {
    const result = await harness.auth.login(undefined, {
      signal: controller.signal,
      region,
      onDeviceCode: (data) => {
        const url = data.verificationUriComplete || data.verificationUri;
        // Print the manual fallback before attempting to open the user's
        // browser so headless/browser-opener failures never hide the URL
        // and code needed to complete login.
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
        try {
          openUrl(url);
        } catch {
          // Best effort only: the manual fallback has already been printed.
        }
      },
    });
    process.stderr.write(`Logged in to ${result.providerName}.\n`);
    process.exit(0);
  } catch (error) {
    if (controller.signal.aborted) {
      process.stderr.write('Login cancelled.\n');
    } else {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Login failed: ${message}\n`);
    }
    process.exit(1);
  }
}
