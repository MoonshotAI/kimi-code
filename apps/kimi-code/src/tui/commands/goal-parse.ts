/**
 * The `/goal` command grammar, shared by the TUI slash command and the
 * headless `kimi -p "/goal …"` path. Keep this module free of UI imports: the
 * headless runner must be able to parse a goal without loading the TUI.
 */

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly replace: boolean;
    }
  | { readonly kind: 'next-add'; readonly objective: string }
  | { readonly kind: 'next-manage' }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly severity?: 'error' | 'hint';
      /** Restore the typed `/goal ...` line into the editor so the input is not lost. */
      readonly restoreInput?: boolean;
    };

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'cancel']);

/**
 * Parses the deterministic `/goal` command grammar. Reserved subcommands
 * (`pause`/`resume`/`cancel`/`status`/`replace`) are only honored as the first
 * token; use `/goal -- <objective>` to start a goal whose text begins with one
 * of those words. (`cancel` is the single discard action — it removes the
 * current goal.) Stop conditions are expressed in the objective in natural
 * language (e.g. "…or stop after 20 turns"); the model honors them when it
 * self-audits each turn and reports `complete`/`blocked` via UpdateGoal.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first === 'next') {
    return parseNextGoalCommand(tokens);
  }
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'cancel' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }
  // `--` ends subcommand parsing so an objective can begin with a reserved word
  // (e.g. `/goal -- pause the rollout`).
  if (tokens[index] === '--') {
    index += 1;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    // A usage hint, not a failure — shown in the same calm style as the other
    // "nothing to act on" messages (no goal to pause/resume/cancel).
    return {
      kind: 'error',
      severity: 'hint',
      message: 'Provide a goal objective, e.g. `/goal Ship feature X`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      restoreInput: true,
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Put long content in a file and reference the file path.`,
    };
  }
  return { kind: 'create', objective, replace };
}

function parseNextGoalCommand(tokens: readonly string[]): ParsedGoalCommand {
  if (tokens.length === 2 && tokens[1] === 'manage') return { kind: 'next-manage' };
  let index = 1;
  if (tokens[index] === '--') index += 1;
  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return {
      kind: 'error',
      severity: 'hint',
      message:
        'Provide an upcoming goal objective, e.g. `/goal next Ship feature X`, or use `/goal next manage`.',
    };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      restoreInput: true,
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Put long content in a file and reference the file path.`,
    };
  }
  return { kind: 'next-add', objective };
}

/**
 * Live pre-send check for the main editor: when the typed text is a `/goal`
 * create/next command whose objective already exceeds the length limit,
 * returns a warning to show while typing — before anything is submitted or
 * sent to the server. Returns undefined for non-goal input and for control
 * forms (`status`/`pause`/`resume`/`cancel`/`next manage`).
 */
export function goalObjectiveLengthWarning(text: string): string | undefined {
  // Submitted text is trimmed before dispatch, so match leading whitespace.
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('/goal')) return undefined;
  const args = trimmed.slice('/goal'.length);
  // parseSlashInput splits the command name at a literal space only, so a
  // newline/tab boundary (`/goal⏎…`, `/goalfoo`) is not the goal command.
  if (args.length > 0 && args.charAt(0) !== ' ') return undefined;
  const objective = extractGoalObjective(args);
  if (objective === undefined || objective.length <= MAX_GOAL_OBJECTIVE_LENGTH) return undefined;
  return `Goal objective is too long (${objective.length}/${MAX_GOAL_OBJECTIVE_LENGTH} characters); put long content in a file and reference the file path.`;
}

/**
 * Mirrors the parse grammar above: strips `next` / `replace` / `--` and
 * returns the objective text, or undefined when the args form a control
 * command that carries no objective.
 */
function extractGoalObjective(rawArgs: string): string | undefined {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return undefined;
  const tokens = args.split(/\s+/);
  const first = tokens[0];
  let index = 0;
  if (first === 'next') {
    if (tokens.length === 2 && tokens[1] === 'manage') return undefined;
    index = 1;
  } else {
    if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
      return undefined;
    }
    if (tokens[index] === 'replace') index += 1;
  }
  if (tokens[index] === '--') index += 1;
  return tokens.slice(index).join(' ').trim();
}
