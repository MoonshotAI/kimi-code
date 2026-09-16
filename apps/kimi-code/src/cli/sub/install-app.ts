import type { Command } from 'commander';

import { kimiCodeOfficialInstallUrl } from '#/constant/app';
import { openUrl } from '#/utils/open-url';

export function registerInstallAppCommand(program: Command): void {
  program
    .command('install-app')
    .description('Print the Kimi Code desktop app page and open it in your browser.')
    .action(() => {
      const url = kimiCodeOfficialInstallUrl();
      process.stdout.write(`${url}\n`);
      openUrl(url);
    });
}
