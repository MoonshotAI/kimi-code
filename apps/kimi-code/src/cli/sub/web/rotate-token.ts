import { getLiveServerInstance, rotateServerToken } from '@moonshot-ai/kap-server';
import chalk from 'chalk';
import type { Command } from 'commander';

import { darkColors } from '#/tui/theme/colors';
import { getDataDir } from '#/utils/paths';

import { accessUrlLines, splitTokenFragment } from './access-urls';

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
          'The previous token is now invalid. A running server picks up the new token automatically.\n',
        );

        process.stdout.write(`\n  ${chalk.bold('New server token:')} ${token}\n\n`);

        const instance = await getLiveServerInstance();
        if (instance !== undefined) {
          for (const { label, url: href } of accessUrlLines(instance.host, instance.port, token)) {
            const [base, frag] = splitTokenFragment(href);
            const rendered =
              frag === ''
                ? chalk.hex(darkColors.accent)(base)
                : chalk.hex(darkColors.accent)(base) + chalk.hex(darkColors.textDim)(frag);
            process.stdout.write(`  ${chalk.dim(label)}${rendered}\n`);
          }
        }
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
      }
    });
}
