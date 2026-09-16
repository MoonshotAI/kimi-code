import type { Command } from 'commander';

import { DESKTOP_WEBSITE_URL } from '#/constant/app';
import { openUrl } from '#/utils/open-url';

export function registerInstallAppCommand(program: Command): void {
  program
    .command('install-app')
    .description('Print the Kimi Code desktop app page and open it in your browser.')
    .action(() => {
      process.stdout.write(`${DESKTOP_WEBSITE_URL}\n`);
      openUrl(DESKTOP_WEBSITE_URL);
    });
}
