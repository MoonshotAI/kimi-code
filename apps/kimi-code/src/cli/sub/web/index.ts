/**
 * `kimi web` / `kimi server` — run the local Kimi server (REST + WebSocket +
 * web UI) in the foreground.
 *
 * `kimi web` opens the web UI in the default browser (`--no-open` to skip);
 * `kimi server` runs the same server without opening a browser (`--open` to
 * open). Both stay attached to the terminal and stop with Ctrl+C. Servers left
 * behind by pre-0.28.0 builds are cleaned up with `kimi server kill`.
 */

import type { Command } from 'commander';

import { registerEnsureDaemonCommand } from './ensure-daemon';
import { registerLegacyKillCommand } from './legacy-kill';
import { registerRotateTokenCommand } from './rotate-token';
import { buildWebCommand } from './run';

export function registerWebCommand(program: Command): void {
  const web = buildWebCommand(
    program
      .command('web')
      .description('Run the local Kimi server and open the web UI.'),
  );
  registerRotateTokenCommand(web);
  const server = buildWebCommand(
    program
      .command('server')
      .description('Run the local Kimi server without opening a browser.'),
    { defaultOpen: false },
  );
  registerRotateTokenCommand(server);
  registerEnsureDaemonCommand(server);
  registerLegacyKillCommand(server);
  buildWebCommand(
    program
      .command('rc')
      .alias('remote')
      .description('Run the local Kimi server and open the web UI through Remote Control.'),
    { forceRemoteControl: true },
  );
}
