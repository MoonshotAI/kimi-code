/**
 * `kimi server rotate-token` — generate a new persistent server token.
 *
 * Rewrites `<KIMI_CODE_HOME>/server.token` (0600, atomic). The previous token
 * stops working immediately: a running server re-reads the file on its next
 * auth check, so rotation takes effect without a restart.
 */

import { rotateServerToken } from '@moonshot-ai/server';
import type { Command } from 'commander';

import { getDataDir } from '#/utils/paths';

export function registerRotateTokenCommand(server: Command): void {
  server
    .command('rotate-token')
    .description(
      'Generate a new persistent server token; the previous token stops working immediately.',
    )
    .action(async () => {
      try {
        const token = await rotateServerToken(getDataDir());
        process.stdout.write(`New server token: ${token}\n`);
        process.stdout.write(
          'The previous token is now invalid. A running server picks up the new token automatically.\n',
        );
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
