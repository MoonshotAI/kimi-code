/**
 * Deprecated `kimi server` shim.
 *
 * The `kimi server` command tree was replaced by `kimi web` (foreground
 * server plus the kill/ps/rotate-token management subcommands). Any
 * `kimi server …` invocation — bare or with any subcommand/flags — lands
 * here, prints the deprecation notice, and exits 1. The shim itself is
 * scheduled for removal in the next major version of Kimi Code.
 */

import type { Command } from 'commander';

export const DEPRECATED_SERVER_NOTICE =
  '`kimi server` has been deprecated and no longer works.\n' +
  'Use `kimi web` instead — it runs the local server in the foreground and opens the web UI (`--no-open` to skip).\n' +
  'This notice will be removed in the next major version of Kimi Code.\n';

export function registerDeprecatedServerCommand(program: Command): void {
  program
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
}
