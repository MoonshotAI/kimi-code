import { CLI_COMMAND_NAME } from '#/constant/app';
import { t } from '#/i18n';
import { registerMigrateCommand } from '#/migration/index';
import { Command, Option } from 'commander';

import type { CLIOptions } from './options';
import { registerAcpCommand } from './sub/acp';
import { registerDoctorCommand } from './sub/doctor';
import { registerExportCommand } from './sub/export';
import { registerLoginCommand } from './sub/login';
import { registerProviderCommand } from './sub/provider';
import { registerServerCommand } from './sub/server';
import { registerVisCommand } from './sub/vis';

export type MainCommandHandler = (opts: CLIOptions) => void;
export type MigrateCommandHandler = () => void;
export type PluginNodeRunnerHandler = (entry: string, args: readonly string[]) => void;
export type UpgradeCommandHandler = () => void | Promise<void>;

export function createProgram(
  version: string,
  onMain: MainCommandHandler,
  onMigrate: MigrateCommandHandler,
  onPluginNodeRunner: PluginNodeRunnerHandler = () => {},
  onUpgrade: UpgradeCommandHandler = () => {},
): Command {
  const program = new Command(CLI_COMMAND_NAME)
    .description(t('cli.program.description'))
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', t('cli.program.helpOption'))
    .usage(t('cli.program.usage'))
    .addHelpText('after', `\n${t('cli.program.documentation')}        https://moonshotai.github.io/kimi-code/\n`);

  program
    .addOption(
      new Option(
        '-S, --session [id]',
        t('cli.optionDescriptions.session'),
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-c, --continue', t('cli.optionDescriptions.continue'), false)
    .addOption(new Option('-C').hideHelp().default(false))
    .option('-y, --yolo', t('cli.optionDescriptions.yolo'), false)
    .option('--auto', t('cli.optionDescriptions.auto'), false)
    .addOption(
      new Option(
        '-m, --model <model>',
        t('cli.optionDescriptions.model'),
      ),
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        t('cli.optionDescriptions.prompt'),
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        t('cli.optionDescriptions.outputFormat'),
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        t('cli.optionDescriptions.skillsDir'),
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(
      new Option(
        '--add-dir <dir>',
        t('cli.optionDescriptions.addDir'),
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', t('cli.optionDescriptions.plan'), false);

  registerExportCommand(program);
  registerProviderCommand(program);
  registerAcpCommand(program);
  registerServerCommand(program);
  registerLoginCommand(program);
  registerDoctorCommand(program);
  registerVisCommand(program);
  registerMigrateCommand(program, onMigrate);
  program
    .command('upgrade')
    .alias('update')
    .description(t('cli.commandDescriptions.upgrade'))
    .action(async () => {
      await onUpgrade();
    });

  program
    .command('__plugin_run_node', { hidden: true })
    .argument('<entry>')
    .argument('[args...]')
    .allowUnknownOption(true)
    .action((entry: string, args: string[]) => {
      onPluginNodeRunner(entry, args);
    });

  program.argument('[args...]').action((args: string[]) => {
    if (args.length > 0) {
      program.error(t('cli.errors.unknownCommand', { command: args[0], cliName: CLI_COMMAND_NAME }));
    }

    const raw = program.opts<Record<string, unknown>>();

    const rawSession = raw['session'] ?? raw['resume'];
    const sessionValue = rawSession === true ? '' : (rawSession as string | undefined);
    const yoloValue = raw['yolo'] === true || raw['yes'] === true || raw['autoApprove'] === true;
    const autoValue = raw['auto'] === true;

    const opts: CLIOptions = {
      session: sessionValue,
      continue: raw['continue'] === true || raw['C'] === true,
      yolo: yoloValue,
      auto: autoValue,
      plan: raw['plan'] as boolean,
      model: raw['model'] as string | undefined,
      outputFormat: raw['outputFormat'] as CLIOptions['outputFormat'],
      prompt: raw['prompt'] as string | undefined,
      skillsDirs: raw['skillsDir'] as string[],
      addDirs: raw['addDir'] as string[],
    };

    onMain(opts);
  });

  return program;
}
