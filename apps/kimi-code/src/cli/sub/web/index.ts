/**
 * `kimi web` — run the local Kimi server (REST + WebSocket + web UI) in the
 * foreground and open the web UI in the default browser.
 *
 * The command itself is the runner (`kimi web` = start the server + open the
 * browser; `--no-open` to skip). Management subcommands work off the instance
 * registry (`~/.kimi-code/server/instances/`), so they see every instance
 * sharing this home directory:
 *   - `web kill [serverId]` — stop an instance (default: the longest-running)
 *   - `web ps`              — list connected clients per instance
 *   - `web rotate-token`    — rotate the home-wide bearer token
 */

import type { Command } from 'commander';

import { registerDeprecatedServerCommand } from './deprecated-server';
import { registerKillCommand } from './kill';
import { registerPsCommand } from './ps';
import { registerRotateTokenCommand } from './rotate-token';
import { buildWebCommand } from './run';

export function registerWebCommand(program: Command): void {
  const web = buildWebCommand(
    program
      .command('web')
      .description('Run the local Kimi server and open the web UI.'),
  );
  registerKillCommand(web);
  registerPsCommand(web);
  registerRotateTokenCommand(web);
  registerDeprecatedServerCommand(program);
}
