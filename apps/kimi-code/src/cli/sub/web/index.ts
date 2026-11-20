import type { Command } from 'commander';

import { registerEnsureDaemonCommand, registerSharedDaemonCommands } from './ensure-daemon';
import { registerLegacyKillCommand } from './legacy-kill';
import { registerRotateTokenCommand } from './rotate-token';
import { buildWebCommand } from './run';

export function registerWebCommand(program: Command): void {
  const web = buildWebCommand(
    program
      .command('web')
      .description('Open the web UI and start a local Kimi server if needed.'),
    { sharedDaemon: true },
  );
  registerRotateTokenCommand(web);
  registerSharedDaemonCommands(web);
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
    { forceRemoteControl: true, sharedDaemon: true },
  );
}
