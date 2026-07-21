import { CLI_COMMAND_NAME } from '#/constant/app';
import { registerMigrateCommand } from '#/migration/index';
import { Command, InvalidArgumentError, Option } from 'commander';

import type { CLIOptions } from './options';
import { registerAcpCommand } from './sub/acp';
import { registerDoctorCommand } from './sub/doctor';
import { registerExportCommand } from './sub/export';
import { registerLoginCommand } from './sub/login';
import { registerProviderCommand } from './sub/provider';
import { registerVisCommand } from './sub/vis';
import { registerWebCommand } from './sub/web';

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
    .description('The Starting Point for Next-Gen Agents')
    .version(version, '-V, --version')
    .allowUnknownOption(false)
    .configureHelp({ helpWidth: 100 })
    .helpOption('-h, --help', 'Show help.')
    .usage('[options] [command]')
    .addHelpText('after', '\nDocumentation:        https://moonshotai.github.io/kimi-code/\n');

  program
    .addOption(
      new Option(
        '-S, --session [id]',
        'Resume a session. With ID: resume that session. Without ID: interactively pick.',
      ).argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .addOption(
      new Option('-r, --resume [id]')
        .hideHelp()
        .argParser((val: string | boolean) => (val === true ? '' : (val as string))),
    )
    .option('-c, --continue', 'Continue the previous session for the working directory.', false)
    .addOption(new Option('-C').hideHelp().default(false))
    .option('-y, --yolo', 'Auto-approve regular tool calls; the agent may still ask questions.', false)
    .option('--auto', 'Start in auto permission mode: fully autonomous, the agent will not ask questions.', false)
    .addOption(
      new Option(
        '-m, --model <model>',
        'LLM model alias to use for this invocation. Defaults to default_model in config.toml.',
      ),
    )
    .addOption(
      new Option(
        '-p, --prompt <prompt>',
        'Run one prompt non-interactively and print the response.',
      ),
    )
    .addOption(
      new Option(
        '--output-format <format>',
        'Output format for prompt mode. Defaults to text.',
      ).choices(['text', 'stream-json']),
    )
    .addOption(
      new Option(
        '--skills-dir <dir>',
        'Load skills from this directory instead of auto-discovered user and project directories. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(
      new Option(
        '--agent <name>',
        'Agent profile to use for this invocation (v2 engine only). Custom profiles are discovered from agent directories or loaded via --agent-file.',
      )
        .argParser((value: string, previous: string | undefined) => {
          if (previous !== undefined) {
            throw new InvalidArgumentError('--agent may only be specified once.');
          }
          return value;
        })
        .conflicts('agentFile'),
    )
    .addOption(
      new Option(
        '--agent-file <path>',
        'Load an agent definition from a Markdown file and select it (v2 engine only).',
      )
        .argParser((value: string, previous: string[] | undefined) => {
          if ((previous?.length ?? 0) > 0) {
            throw new InvalidArgumentError('--agent-file may only be specified once.');
          }
          return [value];
        })
        .conflicts('agent')
        .default([]),
    )
    .addOption(
      new Option(
        '--add-dir <dir>',
        'Add an additional workspace directory for this session. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [...(previous ?? []), value])
        .default([]),
    )
    .addOption(new Option('--yes').hideHelp().default(false))
    .addOption(new Option('--auto-approve').hideHelp().default(false))
    .option('--plan', 'Start in plan mode.', false);

  registerExportCommand(program);
  registerProviderCommand(program);
  registerAcpCommand(program);
  registerWebCommand(program);
  registerLoginCommand(program);
  registerDoctorCommand(program);
  registerVisCommand(program);
  registerMigrateCommand(program, onMigrate);
  program
    .command('upgrade')
    .alias('update')
    .description('Upgrade Kimi Code to the latest version.')
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
      program.error(`unknown command '${args[0]}'. See '${CLI_COMMAND_NAME} --help'.`);
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
      agent: raw['agent'] as string | undefined,
      agentFiles: raw['agentFile'] as string[],
      addDirs: raw['addDir'] as string[],
    };

    onMain(opts);
  });

  return program;
}
