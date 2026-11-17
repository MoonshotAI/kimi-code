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
      .command('server', { hidden: true })
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
