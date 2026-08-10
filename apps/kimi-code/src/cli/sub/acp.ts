/**
 * `kimi acp` sub-command.
 *
 * Starts the Agent Client Protocol (ACP) server over stdio so that
 * ACP-compatible clients (editors, IDEs, custom front-ends) can drive
 * a kimi-code session.
 *
 * The ACP server itself lives in Rust (`kimi-acp`, served by the `kimi`
 * binary's `acp` command). This TS sub-command is a pure forwarder: it
 * re-executes the platform Rust binary with the original argv so the Rust
 * CLI parses the flags itself and mirrors the child's exit code — the same
 * pattern `run-shell.ts` uses for the interactive shell. `--login` pivots
 * into the local device-code login flow (the first-class ACP terminal-auth
 * entry point ACP clients hit when they re-invoke the agent binary with
 * `args:['--login']` appended).
 */

import { spawnSync } from 'node:child_process';

import type { Command } from 'commander';

import { t } from '#/i18n';

import { findRustBinary } from '../run-shell';
import { runLoginFlow } from './login-flow';

export function registerAcpCommand(parent: Command): void {
  parent
    .command('acp')
    .description(t('cli.commandDescriptions.acp'))
    .option(
      '--login',
      t('cli.optionDescriptions.acpLogin'),
      false,
    )
    .action(async (opts: { login?: boolean }) => {
      if (opts.login === true) {
        await runLoginFlow();
        return;
      }
      const bin = findRustBinary();
      if (bin === null) {
        process.stderr.write(t('tui.statusMessages.shellNoRustBinary') + '\n');
        process.exit(1);
        return;
      }
      // Replay the original argv so the Rust CLI parses the ACP flags itself
      // (the Rust `kimi acp` serves the protocol over stdio).
      const result = spawnSync(bin, process.argv.slice(2), { stdio: 'inherit' });
      if (result.status !== null) {
        process.exit(result.status);
      }
      if (result.signal !== null) {
        process.kill(process.pid, result.signal);
      }
      process.exit(1);
    });
}
