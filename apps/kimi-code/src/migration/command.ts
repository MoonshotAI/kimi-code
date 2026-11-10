import type { Command } from 'commander';

export interface MigrateCommandOptions {
  readonly run: boolean;
  readonly configOnly: boolean;
}

export function registerMigrateCommand(
  parent: Command,
  onMigrate: (options: MigrateCommandOptions) => void,
): void {
  parent
    .command('migrate')
    .description('Migrate data from a legacy kimi-cli installation into kimi-code.')
    .option(
      '--run',
      'Run the migration non-interactively and print step-by-step logs. Migrates everything unless --config-only is also given.',
      false,
    )
    .option(
      '--config-only',
      'With --run: migrate config, MCP servers, REPL history and skills, but skip chat sessions.',
      false,
    )
    .action((options: { run?: boolean; configOnly?: boolean }) => {
      onMigrate({ run: options.run === true, configOnly: options.configOnly === true });
    });
}
