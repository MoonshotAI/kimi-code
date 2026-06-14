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

const HEADLESS_INPUT_SOURCE_ERROR =
  'Specify exactly one of --prompt, --goal, or --replace-goal.';
const HEADLESS_PLAN_FLAGS_ERROR = 'Cannot combine --approve-plan with --reject-plan.';

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
    .showHelpAfterError()
    .addHelpText(
      'after',
      [
        '',
        'Headless mode runs without the TUI. The process exits when the run ends.',
        '',
        'Usage heads-up:',
        '  Give Kimi exactly one input: --prompt, --goal, or --replace-goal.',
        '  Use --prompt for one turn. Use --goal for autonomous multi-turn work.',
        '  For automation, prefer --status-file and read the JSON state from that file.',
        '  Do not poll the status file in a tight loop. Set a reasonable time limit.',
        '  Stop waiting when the time limit expires or when the Kimi process exits.',
        '  Use --approve-plan or --reject-plan if a plan review may appear.',
        '  Stop a running goal with: kimi headless goal pause|cancel|interrupt --file <status.json>',
        '',
        'Commands guide:',
        '  run: start a headless prompt or goal run.',
        '    Use it when you want Kimi to do work without opening the TUI.',
        '  status: read the status file written by a run.',
        '    Use it to inspect progress, active tools, output files, and errors.',
        '  goal: send pause, cancel, or interrupt to a running goal.',
        '    Use it only with the status file from a goal run.',
        '',
        'Options guide:',
        '  --prompt: run one turn with this instruction.',
        '    Use this for bounded work where one assistant answer is enough.',
        '  --goal: create a multi-turn goal and keep running until the goal stops.',
        '    Use this for autonomous work that may need several turns.',
        '  --replace-goal: replace the active goal in the session, then run the new goal.',
        '    Use this when the old goal should no longer continue.',
        '  --cwd: run from this working directory.',
        '    Use this when the caller is not already in the target repository.',
        '  --session: resume a specific session id.',
        '    Use this when the caller already knows which session to continue.',
        '  --continue: resume the latest session for the working directory.',
        '    Use this when the caller wants to continue recent work in the same repo.',
        '  --model: override the configured model for this run.',
        '    Use this for one-off model selection without editing config.toml.',
        '  --status-file: write live JSON status for polling.',
        '    Use this when another process needs state, active tool, goal progress, errors, or output paths.',
        '  --output-dir: write Markdown responses to files.',
        '    Use this for long output, multi-turn goals, or when stdout must stay machine-readable.',
        '  --metadata-only: print only the final JSON metadata line.',
        '    Use this when another program reads stdout and response text is available from files or status.',
        '  --approve-plan: approve a plan review if one appears.',
        '    Use this when Kimi should continue from planning into implementation.',
        '  --reject-plan: reject a plan review if one appears.',
        '    Use this when Kimi should stop after producing a plan.',
        '  --skills-dir: load skills from this directory. Can be repeated.',
        '    Use this to give Kimi a specific skill set for the run.',
        '',
        'Examples with outcomes:',
        '  Run one prompt and print the answer:',
        '    kimi headless run --prompt "inspect"',
        '    What happens: Kimi starts a non-interactive session, runs one turn, then exits.',
        '    Output: stdout starts with one JSON metadata line; Markdown follows after a blank line.',
        '    Possible outcomes: completed or failed.',
        '',
        '  Run one prompt with live progress polling:',
        '    kimi headless run --prompt "fix tests" --status-file /tmp/kimi-run/status.json',
        '    What happens: Kimi updates the status file while the turn runs.',
        '    Polling: read the file at a reasonable interval until Kimi exits or your time limit expires.',
        '    Possible outcomes: running, completed, failed, or cancelled.',
        '',
        '  Run a multi-turn goal and write each turn to files:',
        '    kimi headless run --goal "raise coverage" --status-file /tmp/kimi-run/status.json --output-dir /tmp/kimi-run',
        '    What happens: Kimi creates a goal and continues across turns until the goal stops.',
        '    Output: each completed turn is written under /tmp/kimi-run/turns, and goal status is written as JSON.',
        '    Possible outcomes: completed, paused, failed, cancelled, or interrupted.',
        '',
        '  Check progress:',
        '    kimi headless status --file /tmp/kimi-run/status.json',
        '    What happens: Kimi prints a compact summary of a running or finished run.',
        '    Use --json when another program needs the full status object.',
        '',
        '  Pause a running goal after the current turn:',
        '    kimi headless goal pause --file /tmp/kimi-run/status.json --wait',
        '    What happens: Kimi sends the request through the run control file.',
        '    With --wait, this command waits until the running process applies the request or exits.',
        '    Possible outcomes: control applied, control pending, or the run already ended.',
      ].join('\n'),
    );

  addRootGoalOptions(headless);

  const run = headless
    .command('run')
    .description('Run a prompt or goal without the TUI.')
    .addHelpText(
      'after',
      [
        '',
        'What happens: Kimi starts a non-interactive run, then exits.',
        'Use --prompt for one turn. Use --goal or --replace-goal for multi-turn goal work.',
        'Default stdout starts with one JSON metadata line. Markdown follows unless you use --metadata-only or --output-dir.',
        '',
        'Possible outcomes: completed, paused, failed, cancelled, or interrupted.',
        '  completed: the prompt turn finished, or the goal was marked complete.',
        '  paused: the goal stopped and can be resumed later.',
        '  failed: the turn failed, or the goal became blocked.',
        '  cancelled: the process received SIGINT or SIGTERM.',
        '  interrupted: a control command stopped the active turn.',
        '',
        'Examples with outcomes:',
        '  kimi headless run --prompt "inspect"',
        '    Runs one turn and prints metadata plus Markdown. Outcomes: completed or failed.',
        '  kimi headless run --prompt "inspect" --metadata-only',
        '    Runs one turn and prints only metadata. Use this when another program reads stdout.',
        '  kimi headless run --goal "raise coverage to 99.5%" --status-file /tmp/kimi-run/status.json',
        '    Runs a goal across turns and writes live status. Outcomes: completed, paused, failed, cancelled, or interrupted.',
      ].join('\n'),
    );
  addRunOptions(run, { includePrompt: true });
  run.action((options: RawHeadlessRunOptions) => {
    onHeadless({
      kind: 'run',
      options: buildRunOptions(options, run),
    });
  });

  const status = headless
    .command('status')
    .description('Read a status file written by headless run.')
    .requiredOption('--file <path>', 'Read this status file.')
    .option('--json', 'Print the complete status JSON.', false)
    .addHelpText(
      'after',
      [
        '',
        'What happens: Kimi reads the status JSON and prints the current state.',
        'Use this while a run is active or after it exits.',
        'The compact output includes state, session, turn, active tool, goal, files, and control details when available.',
        'Use --json when another program needs the complete status object.',
        '',
        'Possible states include: starting, running, approval_required, paused, completed, failed, cancelled, interrupted.',
        '',
        'Example:',
        '  kimi headless status --file /tmp/kimi-run/status.json',
        '    Prints a human-readable summary.',
        '  kimi headless status --file /tmp/kimi-run/status.json --json',
        '    Prints the full JSON object for automation.',
      ].join('\n'),
    );
  status.action((options: RawHeadlessStatusOptions) => {
    onHeadless({
      kind: 'status',
      options: buildStatusOptions(options, status),
    });
  });

  const goal = headless
    .command('goal')
    .description('Send a control request to a goal run.')
    .addHelpText(
      'after',
      [
        '',
        'What happens: Kimi writes a control request for the running goal.',
        'The running headless process reads that request from its control file.',
        'Use --wait to wait until the running process applies the request or exits.',
        '',
        'Actions:',
        '  pause: let the current turn finish, then pause before the next turn.',
        '  cancel: let the current turn finish, then cancel the goal.',
        '  interrupt: stop the active turn now and leave the goal paused when possible.',
        '',
        'Example:',
        '  kimi headless goal pause --file /tmp/kimi-run/status.json --wait',
        '    Sends a pause request and waits for it to be applied.',
      ].join('\n'),
    );
  registerGoalControlCommand(goal, 'pause', 'pause_goal', onHeadless);
  registerGoalControlCommand(goal, 'cancel', 'cancel_goal', onHeadless);
  registerGoalControlCommand(goal, 'interrupt', 'interrupt', onHeadless);

  headless.action((options: RawHeadlessRunOptions) => {
    onHeadless({
      kind: 'run',
      options: buildRunOptions(options, headless),
    });
  });
}

function addRootGoalOptions(command: Command): void {
  command.addOption(new Option('--goal <objective>', 'Create and run a multi-turn goal.'));
  addSharedRunOptions(command);
}

function addRunOptions(command: Command, options: { readonly includePrompt: boolean }): void {
  command.showHelpAfterError();
  if (options.includePrompt) {
    command.addOption(new Option('--prompt <prompt>', 'Run one turn with this instruction.'));
  }
  command.addOption(new Option('--goal <objective>', 'Create and run a multi-turn goal.'));
  command.addOption(
    new Option('--replace-goal <objective>', 'Replace the active goal, then run the new goal.'),
  );
  addSharedRunOptions(command);
}

function addSharedRunOptions(command: Command): void {
  command
    .addOption(new Option('--cwd <dir>', 'Run from this working directory.'))
    .addOption(new Option('--session <id>', 'Resume a specific session.'))
    .option('--continue', 'Continue the latest session for the working directory.', false)
    .addOption(new Option('--model <model>', 'Use this model for this run only.'))
    .addOption(new Option('--status-file <path>', 'Write live JSON status for polling.'))
    .addOption(new Option('--output-dir <dir>', 'Write Markdown responses to files.'))
    .option('--metadata-only', 'Print only the final JSON metadata line.', false)
    .option('--approve-plan', 'Approve a plan review if one appears.', false)
    .option('--reject-plan', 'Reject a plan review if one appears.', false)
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

function buildRunOptions(raw: RawHeadlessRunOptions, command: Command): HeadlessRunOptions {
  const prompt = normalizeOptionalString(raw.prompt);
  const goal = normalizeOptionalString(raw.goal);
  const replaceGoal = normalizeOptionalString(raw.replaceGoal);
  const inputCount = [prompt, goal, replaceGoal].filter((value) => value !== undefined).length;
  if (inputCount !== 1) {
    command.error(HEADLESS_INPUT_SOURCE_ERROR);
  }
  if (raw.approvePlan === true && raw.rejectPlan === true) {
    command.error(HEADLESS_PLAN_FLAGS_ERROR);
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
