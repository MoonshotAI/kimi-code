/**
 * `kimi acp-v2` sub-command.
 *
 * Starts the Agent Client Protocol (ACP) server backed directly by the
 * DI × Scope agent engine (`agent-core-v2`) over stdio, so ACP-compatible
 * clients can drive a kimi-code session on the new engine. This is the v2
 * counterpart to `kimi acp` (which runs the legacy `@moonshot-ai/acp-adapter`
 * over the SDK harness).
 *
 * Wire-up mirrors `kimi acp` for the parts that are host-independent:
 *  - `--login` pivots into the shared device-code login flow (the entry point
 *    ACP clients hit via the first-class `AuthMethodTerminal` path, re-invoking
 *    the agent binary with the advertised `args:['--login']`).
 *  - `KIMI_CODE_HOME` (if set) is forwarded into `authMethods[0].env` so the
 *    login subprocess writes its token under the same data root the server
 *    reads from, and `process.argv[1]` is advertised as the legacy
 *    `_meta['terminal-auth'].command` fallback.
 *
 * `@moonshot-ai/acp-server` (and its `agent-core-v2` engine) is loaded via a
 * lazy dynamic import so the default CLI / `kimi acp` module graph stays free
 * of the experimental v2 engine — mirroring the `kimi server run` v2 routing
 * in `#/cli/sub/server/run.ts`.
 */

import type { Command } from 'commander';

import { getVersion } from '#/cli/version';
import { KIMI_CODE_HOME_ENV } from '#/constant/app';
import { getDataDir } from '#/utils/paths';

import { runLoginFlow } from './login-flow';

export function registerAcpV2Command(parent: Command): void {
  parent
    .command('acp-v2')
    .description(
      'Run kimi-code as an Agent Client Protocol (ACP) server over stdio (experimental agent-core-v2 engine).',
    )
    .option(
      '--login',
      'Run the device-code login flow then exit (entry point for ACP terminal-auth).',
      false,
    )
    .action(async (opts: { login?: boolean }) => {
      if (opts.login === true) {
        await runLoginFlow();
        return;
      }
      // Forward `KIMI_CODE_HOME` (if set) into `authMethods[0].env` so the
      // login subprocess clients spawn for terminal-auth writes its token
      // under the same data root the ACP server reads from.
      const sandboxHome = process.env[KIMI_CODE_HOME_ENV];
      const terminalAuthEnv =
        sandboxHome !== undefined && sandboxHome.length > 0
          ? { [KIMI_CODE_HOME_ENV]: sandboxHome }
          : undefined;
      // Legacy `_meta.terminal-auth` fallback for clients that don't yet
      // honor the first-class `type:'terminal'`. `command` is the absolute
      // path to this very binary so the client can spawn it for login.
      const legacyCommand = process.argv[1];
      try {
        const { runAcpServer } = await import('@moonshot-ai/acp-server');
        await runAcpServer({
          homeDir: getDataDir(),
          agentInfo: { name: 'Kimi Code CLI', version: getVersion() },
          ...(terminalAuthEnv ? { terminalAuthEnv } : {}),
          ...(legacyCommand !== undefined && legacyCommand.length > 0
            ? { terminalAuthLegacyCommand: legacyCommand }
            : {}),
        });
        process.exit(0);
      } catch (error) {
        process.stderr.write(`acp-v2 server: fatal error: ${String(error)}\n`);
        process.exit(1);
      }
    });
}
