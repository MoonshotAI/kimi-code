import type { GoalSnapshot } from '#/agent/goal/types';
import { Disposable } from "#/_base/di/lifecycle";
import { renderPrompt } from "#/_base/utils/render-prompt";
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import GOAL_ACTIVE_REMINDER from './goal-active-reminder.md?raw';
import GOAL_BLOCKED_REMINDER from './goal-blocked-reminder.md?raw';
import GOAL_PAUSED_REMINDER from './goal-paused-reminder.md?raw';

export interface GoalInjectionOptions {
  readonly getGoal: () => GoalSnapshot | null;
}

export class GoalInjection extends Disposable {
  constructor(
    private readonly options: GoalInjectionOptions,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
  ) {
    super();
    this._register(
      dynamicInjector.register('goal', ({ isNewTurn }) => (isNewTurn ? this.reminder() : undefined)),
    );
  }

  private reminder(): string | undefined {
    const goal = this.options.getGoal();
    if (goal === null) return undefined;
    if (goal.status === 'active') return buildGoalReminder(goal);
    if (goal.status === 'blocked') return buildBlockedNote(goal);
    if (goal.status === 'paused') return buildPausedNote(goal);
    return undefined;
  }
}

const BUDGET_GUIDANCE_NEARING =
  'Budget guidance: you are nearing a budget. Converge on the objective and avoid starting new discretionary work.';
const BUDGET_GUIDANCE_WITHIN =
  'Budget guidance: you are within budget. Make steady, focused progress toward the objective.';

function buildBlockedNote(goal: GoalSnapshot): string {
  return renderPrompt(GOAL_BLOCKED_REMINDER, {
    reason_suffix: reasonSuffix(goal),
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
  });
}

function buildPausedNote(goal: GoalSnapshot): string {
  return renderPrompt(GOAL_PAUSED_REMINDER, {
    reason_suffix: reasonSuffix(goal),
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
  });
}

function buildGoalReminder(goal: GoalSnapshot): string {
  const budgets = formatBudgets(goal);
  return renderPrompt(GOAL_ACTIVE_REMINDER, {
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
    status: goal.status,
    progress: `${goal.turnsUsed} continuation turns, ${goal.tokensUsed} tokens, ${formatElapsed(goal.wallClockMs)} elapsed`,
    budgets_block: budgets.length > 0 ? `Budgets: ${budgets}.\n` : '',
    budget_guidance: isNearingBudget(goal) ? BUDGET_GUIDANCE_NEARING : BUDGET_GUIDANCE_WITHIN,
  });
}

function reasonSuffix(goal: GoalSnapshot): string {
  const reason = goal.terminalReason;
  return reason === undefined ? '' : ` (${escapeUntrustedText(reason)})`;
}

function completionCriterionBlock(goal: GoalSnapshot): string {
  if (goal.completionCriterion === undefined) return '';
  return `<untrusted_completion_criterion>\n${escapeUntrustedText(goal.completionCriterion)}\n</untrusted_completion_criterion>\n`;
}

function formatBudgets(goal: GoalSnapshot): string {
  const budgetLines: string[] = [];
  if (goal.budget.turnBudget !== null) {
    budgetLines.push(
      `turns ${goal.turnsUsed}/${goal.budget.turnBudget} (remaining ${goal.budget.remainingTurns})`,
    );
  }
  if (goal.budget.tokenBudget !== null) {
    budgetLines.push(
      `tokens ${goal.tokensUsed}/${goal.budget.tokenBudget} (remaining ${goal.budget.remainingTokens})`,
    );
  }
  if (goal.budget.wallClockBudgetMs !== null) {
    budgetLines.push(
      `time ${formatElapsed(goal.wallClockMs)}/${formatElapsed(goal.budget.wallClockBudgetMs)} (remaining ${formatElapsed(goal.budget.remainingWallClockMs ?? 0)})`,
    );
  }
  return budgetLines.join('; ');
}

function isNearingBudget(goal: GoalSnapshot): boolean {
  return maxBudgetFraction(goal) >= 0.75;
}

function maxBudgetFraction(goal: GoalSnapshot): number {
  const fractions: number[] = [];
  if (goal.budget.turnBudget !== null && goal.budget.turnBudget > 0) {
    fractions.push(goal.turnsUsed / goal.budget.turnBudget);
  }
  if (goal.budget.tokenBudget !== null && goal.budget.tokenBudget > 0) {
    fractions.push(goal.tokensUsed / goal.budget.tokenBudget);
  }
  if (goal.budget.wallClockBudgetMs !== null && goal.budget.wallClockBudgetMs > 0) {
    fractions.push(goal.wallClockMs / goal.budget.wallClockBudgetMs);
  }
  return fractions.length === 0 ? 0 : Math.max(...fractions);
}

function escapeUntrustedText(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${(minutes % 60).toString().padStart(2, '0')}m`;
}
