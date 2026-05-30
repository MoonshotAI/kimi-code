import { ErrorCodes, isKimiError, type GoalSnapshot } from '@moonshot-ai/kimi-code-sdk';

import { LLM_NOT_SET_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;
const RESUME_GOAL_INPUT = 'Resume the active goal.';

interface GoalBudgetLimits {
  tokenBudget?: number;
  turnBudget?: number;
  wallClockBudgetMs?: number;
}

export type ParsedGoalCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'clear' }
  | {
      readonly kind: 'create';
      readonly objective: string;
      readonly replace: boolean;
      readonly budgetLimits: GoalBudgetLimits;
    }
  | { readonly kind: 'error'; readonly message: string };

const CONTROL_SUBCOMMANDS = new Set(['pause', 'resume', 'cancel', 'clear']);

/**
 * Parses the deterministic `/goal` command grammar. Reserved subcommands
 * (`pause`/`resume`/`cancel`/`clear`/`status`/`replace`) are only honored as the
 * first token; use `/goal -- <objective>` to start a goal whose text begins
 * with one of those words. Budget options must precede the objective.
 */
export function parseGoalCommand(rawArgs: string): ParsedGoalCommand {
  const args = rawArgs.trim();
  if (args.length === 0 || args === 'status') return { kind: 'status' };

  const tokens = args.split(/\s+/);
  const first = tokens[0];
  if (first !== undefined && CONTROL_SUBCOMMANDS.has(first) && tokens.length === 1) {
    return { kind: first as 'pause' | 'resume' | 'cancel' | 'clear' };
  }

  let index = 0;
  let replace = false;
  if (tokens[index] === 'replace') {
    replace = true;
    index += 1;
  }

  const budgetLimits: GoalBudgetLimits = {};
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index += 1;
      break;
    }
    const option = parseBudgetOption(token);
    if (option === undefined) break; // start of the objective
    const rawValue = tokens[index + 1];
    const value = parsePositiveInteger(rawValue);
    if (value === undefined) {
      return { kind: 'error', message: `\`${token}\` requires a positive integer value.` };
    }
    if (option === 'tokenBudget') budgetLimits.tokenBudget = value;
    else if (option === 'turnBudget') budgetLimits.turnBudget = value;
    else budgetLimits.wallClockBudgetMs = value * 60_000;
    index += 2;
  }

  const objective = tokens.slice(index).join(' ').trim();
  if (objective.length === 0) {
    return { kind: 'error', message: 'Provide a goal objective, e.g. `/goal Ship feature X`.' };
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    return {
      kind: 'error',
      message: `Goal objective is too long (max ${MAX_GOAL_OBJECTIVE_LENGTH} characters). Reference long details by file path.`,
    };
  }
  return { kind: 'create', objective, replace, budgetLimits };
}

function parseBudgetOption(
  token: string | undefined,
): 'tokenBudget' | 'turnBudget' | 'wallClockBudgetMs' | undefined {
  switch (token) {
    case '--max-tokens':
      return 'tokenBudget';
    case '--max-turns':
      return 'turnBudget';
    case '--max-minutes':
      return 'wallClockBudgetMs';
    default:
      return undefined;
  }
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

export async function handleGoalCommand(host: SlashCommandHost, args: string): Promise<void> {
  const parsed = parseGoalCommand(args);
  switch (parsed.kind) {
    case 'error':
      host.showError(parsed.message);
      return;
    case 'status':
      await showGoalStatus(host);
      return;
    case 'pause':
      await pauseGoal(host);
      return;
    case 'resume':
      await resumeGoal(host);
      return;
    case 'cancel':
      await cancelGoal(host);
      return;
    case 'clear':
      await clearGoal(host);
      return;
    case 'create':
      await createGoal(host, parsed);
      return;
  }
}

async function createGoal(
  host: SlashCommandHost,
  parsed: Extract<ParsedGoalCommand, { kind: 'create' }>,
): Promise<void> {
  // A goal must be able to start a model turn; refuse to create one otherwise.
  if (host.state.appState.model.trim().length === 0 || host.session === undefined) {
    host.showError(LLM_NOT_SET_MESSAGE);
    return;
  }
  try {
    await host.requireSession().createGoal({
      objective: parsed.objective,
      replace: parsed.replace,
      budgetLimits: parsed.budgetLimits,
    });
  } catch (error) {
    if (isKimiError(error) && error.code === ErrorCodes.GOAL_ALREADY_EXISTS) {
      host.showError(
        'A goal is already active. Use `/goal replace <objective>` to replace it, or `/goal status` to inspect it.',
      );
      return;
    }
    host.showError(formatErrorMessage(error));
    return;
  }
  host.track('goal_create', { replace: parsed.replace });
  const unbounded =
    parsed.budgetLimits.tokenBudget === undefined &&
    parsed.budgetLimits.turnBudget === undefined &&
    parsed.budgetLimits.wallClockBudgetMs === undefined;
  host.showStatus(
    unbounded
      ? `Goal set: ${parsed.objective}\nNo stop condition set — runs until the evaluator judges it complete. Add a clause like "…or stop after 20 turns", or pass --max-turns / --max-minutes / --max-tokens, to bound it.`
      : `Goal set: ${parsed.objective}`,
  );
  host.sendNormalUserInput(parsed.objective);
}

async function pauseGoal(host: SlashCommandHost): Promise<void> {
  await host.requireSession().pauseGoal();
  if (isStreaming(host)) host.cancelInFlight?.();
  host.showStatus('Goal paused. Use `/goal resume` to continue.');
}

async function resumeGoal(host: SlashCommandHost): Promise<void> {
  await host.requireSession().resumeGoal();
  host.showStatus('Goal resumed.');
  host.sendNormalUserInput(RESUME_GOAL_INPUT);
}

async function cancelGoal(host: SlashCommandHost): Promise<void> {
  await host.requireSession().cancelGoal();
  if (isStreaming(host)) host.cancelInFlight?.();
  host.showStatus('Goal cancelled.');
}

async function clearGoal(host: SlashCommandHost): Promise<void> {
  await host.requireSession().clearGoal();
  if (isStreaming(host)) host.cancelInFlight?.();
  host.showStatus('Goal cleared.');
}

async function showGoalStatus(host: SlashCommandHost): Promise<void> {
  const { goal } = await host.requireSession().getGoal();
  if (goal === null) {
    host.showStatus('No goal set. Start one with `/goal <objective>`.');
    return;
  }
  host.showStatus(formatGoalStatus(goal));
}

function formatGoalStatus(goal: GoalSnapshot): string {
  const lines: string[] = [];
  lines.push(`Goal [${goal.status}]: ${goal.objective}`);
  if (goal.completionCriterion !== undefined) {
    lines.push(`Completion criterion: ${goal.completionCriterion}`);
  }
  const budget = goal.budget;
  const turnPart =
    budget.turnBudget === null
      ? `turns: ${goal.turnsUsed}`
      : `turns: ${goal.turnsUsed}/${budget.turnBudget}`;
  const tokenPart =
    budget.tokenBudget === null
      ? `tokens: ${goal.tokensUsed}`
      : `tokens: ${goal.tokensUsed}/${budget.tokenBudget}`;
  lines.push(`${turnPart}, ${tokenPart}, time: ${formatDuration(goal.wallClockMs)}`);
  if (budget.wallClockBudgetMs !== null) {
    lines.push(`time budget: ${formatDuration(budget.wallClockBudgetMs)}`);
  }
  if (budget.overBudget) lines.push('Budget reached.');
  if (goal.terminalReason !== undefined) lines.push(`Reason: ${goal.terminalReason}`);
  if (goal.lastEvaluatorVerdict !== undefined) {
    lines.push(`Last evaluator verdict: ${goal.lastEvaluatorVerdict}`);
  }
  return lines.join('\n');
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

function isStreaming(host: SlashCommandHost): boolean {
  return host.state.appState.streamingPhase !== 'idle';
}
