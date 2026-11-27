import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

import { isSharedDaemonSupported, stopDaemonRemoteControl } from './daemon-client';
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
    { defaultOpen: false, includeHiddenDaemonServerFlag: true },
  );
  registerRotateTokenCommand(server);
  registerEnsureDaemonCommand(server);
  registerLegacyKillCommand(server);
  const rc = buildWebCommand(
    program
      .command('rc')
      .alias('remote')
      .description('Run the local Kimi server and open the web UI through Remote Control.'),
    { forceRemoteControl: true },
  );
  rc.command('stop')
    .description('Stop Remote Control on the background daemon and clear its saved preference.')
    .action(async () => {
      try {
        if (!isSharedDaemonSupported()) {
          throw new Error(
            "Kimi background daemon is not yet supported on Windows; stop foreground 'kimi rc' with Ctrl+C.",
          );
        }
        const wasActive = await stopDaemonRemoteControl(getDataDir());
        process.stdout.write(
          wasActive ? 'Remote Control stopped.\n' : 'Remote Control is not running.\n',
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
