/**
 * Deprecated `kimi server` shim.
 *
 * The `kimi server` command tree was replaced by `kimi web` (a foreground
 * server opened in the browser). Any `kimi server …` invocation — bare or
 * with any legacy subcommand/flags — lands here, prints the deprecation
 * notice, and exits 1. The shim itself is scheduled for removal in the next
 * major version of Kimi Code.
 *
 * One subcommand stays functional: `kimi server kill`, the cleanup path for
 * background servers started by pre-0.28.0 builds (recorded in the legacy
 * single-instance lock, which the instance registry never sees).
 */

import type { Command } from 'commander';

import { registerLegacyKillCommand } from './legacy-kill';

export const DEPRECATED_SERVER_NOTICE =
  '`kimi server` has been deprecated and no longer works.\n' +
  'Use `kimi web` instead — it runs the local server in the foreground and opens the web UI (`--no-open` to skip).\n' +
  'To stop a server started by a version before 0.28.0, use `kimi server kill`.\n' +
  'This notice will be removed in the next major version of Kimi Code.\n';

export function registerDeprecatedServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description('Deprecated — use `kimi web` instead.')
    // Swallow every legacy subcommand/flag (`run`, `kill`, `--port`, …) so
    // they all land in the same notice instead of a commander parse error.
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(() => {
      process.stderr.write(DEPRECATED_SERVER_NOTICE);
      process.exit(1);
    });
  registerLegacyKillCommand(server);
}
