/**
 * Shared interactive authentication flow used by both `kimi login`
 * (top-level subcommand) and `kimi acp --login` (the first-class ACP
 * terminal-auth entry point).
 *
 * The login-only shell opens the same platform selector as `/login`, so
 * account OAuth and Kimi Platform API-key setup keep one implementation.
 */

import type { CLIOptions } from '#/cli/options';
import { runShell } from '#/cli/run-shell';
import { getVersion } from '#/cli/version';

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

export async function runLoginFlow(): Promise<void> {
  await runShell(LOGIN_CLI_OPTIONS, getVersion(), { loginOnly: true });
}
