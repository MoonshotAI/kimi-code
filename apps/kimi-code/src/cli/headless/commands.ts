import { Command, Option } from 'commander';

export type HeadlessControlAction = 'pause_goal' | 'cancel_goal' | 'interrupt';

export interface HeadlessRunOptions {
  readonly prompt?: string;
  readonly goal?: string;
  readonly replaceGoal?: string;
  readonly cwd?: string;
  readonly session?: string;
  readonly continue: boolean;
  readonly model?: string;
  readonly statusFile?: string;
  readonly outputDir?: string;
  readonly metadataOnly: boolean;
  readonly approvePlan: boolean;
  readonly rejectPlan: boolean;
  readonly skillsDirs: readonly string[];
}

export interface HeadlessStatusOptions {
  readonly file: string;
  readonly json: boolean;
}

export interface HeadlessGoalControlOptions {
  readonly action: HeadlessControlAction;
  readonly file: string;
  readonly wait: boolean;
}

export type HeadlessCommand =
  | { readonly kind: 'run'; readonly options: HeadlessRunOptions }
  | { readonly kind: 'status'; readonly options: HeadlessStatusOptions }
  | { readonly kind: 'goal-control'; readonly options: HeadlessGoalControlOptions };

export type HeadlessCommandHandler = (command: HeadlessCommand) => void;

interface RawHeadlessRunOptions {
  readonly prompt?: string;
  readonly goal?: string;
  readonly replaceGoal?: string;
  readonly cwd?: string;
  readonly session?: string;
  readonly continue?: boolean;
  readonly model?: string;
  readonly statusFile?: string;
  readonly outputDir?: string;
  readonly metadataOnly?: boolean;
  readonly approvePlan?: boolean;
  readonly rejectPlan?: boolean;
  readonly skillsDir?: string[];
}

interface RawHeadlessStatusOptions {
  readonly file?: string;
  readonly json?: boolean;
}

interface RawHeadlessGoalControlOptions {
  readonly file?: string;
  readonly wait?: boolean;
}

export function registerHeadlessCommand(
  program: Command,
  onHeadless: HeadlessCommandHandler,
): void {
  const headless = program
    .command('headless')
    .description('Run and inspect non-interactive Kimi Code turns.')
    .addHelpText(
      'after',
      [
        '',
        'Headless mode runs without the TUI. The process exits when the run ends.',
        '',
        'Examples:',
        '  kimi headless run --prompt "inspect"',
        '  kimi headless run --prompt "inspect" --status-file /tmp/kimi-run/status.json',
        '  kimi headless run --prompt "inspect" --output-dir /tmp/kimi-run',
        '  kimi headless --goal "raise coverage to 99.5%" --status-file /tmp/kimi-run/status.json',
        '  kimi headless status --file /tmp/kimi-run/status.json --json',
        '  kimi headless goal pause --file /tmp/kimi-run/status.json',
      ].join('\n'),
    );

  addRootGoalOptions(headless);

  const run = headless
    .command('run')
    .description('Run one turn without the TUI.')
    .addHelpText(
      'after',
      [
        '',
        'Default output starts with one JSON metadata line, then Markdown.',
        '',
        'Examples:',
        '  kimi headless run --prompt "inspect"',
        '  kimi headless run --prompt "inspect" --metadata-only',
        '  kimi headless run --goal "raise coverage to 99.5%" --status-file /tmp/kimi-run/status.json',
      ].join('\n'),
    );
  addRunOptions(run, { includePrompt: true });
  run.action((options: RawHeadlessRunOptions) => {
    onHeadless({
      kind: 'run',
      options: buildRunOptions(options),
    });
  });

  const status = headless
    .command('status')
    .description('Read a status file written by headless run.')
    .requiredOption('--file <path>', 'Read this status file.')
    .option('--json', 'Print raw status JSON.', false);
  status.action((options: RawHeadlessStatusOptions) => {
    onHeadless({
      kind: 'status',
      options: buildStatusOptions(options, status),
    });
  });

  const goal = headless.command('goal').description('Send a control request to a goal run.');
  registerGoalControlCommand(goal, 'pause', 'pause_goal', onHeadless);
  registerGoalControlCommand(goal, 'cancel', 'cancel_goal', onHeadless);
  registerGoalControlCommand(goal, 'interrupt', 'interrupt', onHeadless);

  headless.action((options: RawHeadlessRunOptions) => {
    onHeadless({
      kind: 'run',
      options: buildRunOptions(options),
    });
  });
}

function addRootGoalOptions(command: Command): void {
  command.addOption(new Option('--goal <objective>', 'Create a goal and run it headlessly.'));
  addSharedRunOptions(command);
}

function addRunOptions(command: Command, options: { readonly includePrompt: boolean }): void {
  if (options.includePrompt) {
    command.addOption(new Option('--prompt <prompt>', 'Prompt text.'));
  }
  command.addOption(new Option('--goal <objective>', 'Create a goal and run it headlessly.'));
  command.addOption(
    new Option('--replace-goal <objective>', 'Replace the active goal and run it headlessly.'),
  );
  addSharedRunOptions(command);
}

function addSharedRunOptions(command: Command): void {
  command
    .addOption(new Option('--cwd <dir>', 'Working directory for the run.'))
    .addOption(new Option('--session <id>', 'Resume a specific session.'))
    .option('--continue', 'Continue the latest session for the working directory.', false)
    .addOption(new Option('--model <model>', 'LLM model alias to use for this run.'))
    .addOption(new Option('--status-file <path>', 'Write run status updates to this JSON file.'))
    .addOption(new Option('--output-dir <dir>', 'Write response files to this directory.'))
    .option('--metadata-only', 'Print only the JSON metadata line.', false)
    .option('--approve-plan', 'Approve plan-exit requests only.', false)
    .option('--reject-plan', 'Reject plan-exit requests only.', false)
    .addOption(
      new Option(
        '--skills-dir <dir>',
        'Load skills from this directory. Can be repeated.',
      )
        .argParser((value: string, previous: string[] | undefined) => [
          ...(previous ?? []),
          value,
        ])
        .default([]),
    );
}

function registerGoalControlCommand(
  goal: Command,
  name: string,
  action: HeadlessControlAction,
  onHeadless: HeadlessCommandHandler,
): void {
  const command = goal
    .command(name)
    .description(getGoalControlDescription(action))
    .requiredOption('--file <path>', 'Status file for the running headless goal.')
    .option('--wait', 'Wait until the running process applies the request.', false);

  command.action((options: RawHeadlessGoalControlOptions) => {
    onHeadless({
      kind: 'goal-control',
      options: buildGoalControlOptions(options, action, command),
    });
  });
}

function getGoalControlDescription(action: HeadlessControlAction): string {
  switch (action) {
    case 'pause_goal':
      return 'Let the current turn finish, then pause the goal.';
    case 'cancel_goal':
      return 'Let the current turn finish, then cancel the goal.';
    case 'interrupt':
      return 'Stop the active turn now and leave the goal paused when possible.';
  }
}

function buildRunOptions(raw: RawHeadlessRunOptions): HeadlessRunOptions {
  const prompt = normalizeOptionalString(raw.prompt);
  const goal = normalizeOptionalString(raw.goal);
  const replaceGoal = normalizeOptionalString(raw.replaceGoal);
  const inputCount = [prompt, goal, replaceGoal].filter((value) => value !== undefined).length;
  if (inputCount !== 1) {
    throw new Error('Specify exactly one of --prompt, --goal, or --replace-goal.');
  }
  if (raw.approvePlan === true && raw.rejectPlan === true) {
    throw new Error('Cannot combine --approve-plan with --reject-plan.');
  }

  return {
    prompt,
    goal,
    replaceGoal,
    cwd: normalizeOptionalString(raw.cwd),
    session: normalizeOptionalString(raw.session),
    continue: raw.continue === true,
    model: normalizeOptionalString(raw.model),
    statusFile: normalizeOptionalString(raw.statusFile),
    outputDir: normalizeOptionalString(raw.outputDir),
    metadataOnly: raw.metadataOnly === true,
    approvePlan: raw.approvePlan === true,
    rejectPlan: raw.rejectPlan === true,
    skillsDirs: raw.skillsDir ?? [],
  };
}

function buildStatusOptions(raw: RawHeadlessStatusOptions, command: Command): HeadlessStatusOptions {
  const file = normalizeOptionalString(raw.file);
  if (file === undefined) {
    command.error('Missing required option --file <path>.');
  }
  return {
    file,
    json: raw.json === true,
  };
}

function buildGoalControlOptions(
  raw: RawHeadlessGoalControlOptions,
  action: HeadlessControlAction,
  command: Command,
): HeadlessGoalControlOptions {
  const file = normalizeOptionalString(raw.file);
  if (file === undefined) {
    command.error('Missing required option --file <path>.');
  }
  return {
    action,
    file,
    wait: raw.wait === true,
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return value;
}
