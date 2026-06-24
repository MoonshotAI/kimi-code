/**
 * `kimi server rotate-token` — generate a new persistent server token.
 *
 * Rewrites `<KIMI_CODE_HOME>/server.token` (0600, atomic). The previous token
 * stops working immediately: a running server re-reads the file on its next
 * auth check, so rotation takes effect without a restart.
 */

import { getLiveLock, rotateServerToken } from '@moonshot-ai/server';
import chalk from 'chalk';
import type { Command } from 'commander';

import { darkColors } from '#/tui/theme/colors';
import { getDataDir } from '#/utils/paths';

import { accessUrlLines } from './access-urls';
import { DEFAULT_SERVER_HOST } from './shared';

export function registerRotateTokenCommand(server: Command): void {
  server
    .command('rotate-token')
    .description(
      'Generate a new persistent server token; the previous token stops working immediately.',
    )
    .action(async () => {
      try {
        const token = await rotateServerToken(getDataDir());
        process.stdout.write(
          `${chalk.bold('New server token:')} ${chalk.bold.hex(darkColors.warning)(token)}\n`,
        );
        process.stdout.write(
          'The previous token is now invalid. A running server picks up the new token automatically.\n',
        );

        // Re-print the access links with the new token so the user can
        // reconnect immediately. When a server is running its bind host/port
        // come from the lock; otherwise there is nothing to connect to yet.
        const lock = getLiveLock();
        if (lock !== undefined) {
          const host = lock.host ?? DEFAULT_SERVER_HOST;
          process.stdout.write('\n');
          for (const { label, url } of accessUrlLines(host, lock.port, token)) {
            process.stdout.write(`  ${chalk.dim(label)}${chalk.hex(darkColors.accent)(url)}\n`);
          }
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
