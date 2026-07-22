/**
 * `kimi web` — run the local Kimi server (REST + WebSocket + web UI) in the
 * foreground and open the web UI in the default browser.
 *
 * The command itself is the runner (`kimi web` = start the server + open the
 * browser; `--no-open` to skip). The server stays attached to the terminal
 * and stops with Ctrl+C, so there is no kill/ps subcommand; the only
 * management subcommand is `web rotate-token` (rotate the home-wide bearer
 * token). Servers left behind by pre-0.28.0 builds are cleaned up with
 * `kimi server kill`.
 */

import type { Command } from 'commander';

import { registerDeprecatedServerCommand } from './deprecated-server';
import { registerRotateTokenCommand } from './rotate-token';
import { buildWebCommand } from './run';

export function registerWebCommand(program: Command): void {
  const web = buildWebCommand(
    program
      .command('web')
      .description('Run the local Kimi server and open the web UI.'),
  );
  registerRotateTokenCommand(web);
  registerDeprecatedServerCommand(program);
}
