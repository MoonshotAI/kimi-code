import { Service } from '#/_base/di/service';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { isCompactionSummaryMessage } from '#/agent/contextMemory/compactionHandoff';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { GoalSnapshot } from '#/features/goal/types';
import type { IAgentReminderService } from '#/features/reminder/reminderService';
import type { ContextInjectionContext, ContextInjectionResult } from '#/features/reminder/types';

import GOAL_ACTIVE_REMINDER from './goal-active-reminder.md?raw';
import GOAL_ACTIVE_SPARSE_REMINDER from './goal-active-sparse-reminder.md?raw';
import GOAL_BLOCKED_REMINDER from './goal-blocked-reminder.md?raw';
import GOAL_PAUSED_REMINDER from './goal-paused-reminder.md?raw';

export interface GoalInjectionOptions {
  readonly getGoal: () => GoalSnapshot | null;
  readonly isWaitForEnabled?: () => boolean;
}

interface GoalReminderDisclosure {
  readonly status: GoalSnapshot['status'];
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly active: boolean;
  readonly budgetBand: 'within' | 'nearing';
  readonly waitForEnabled: boolean;
}

export const GOAL_WAIT_FOR_GUIDANCE =
  'If you are waiting for background sub-agents or bash tasks to finish, call WaitFor to wait for them inside this turn instead of ending the turn; ending the turn just gets you re-invoked again and again. You can also use the waiting time to do useful parallel work. Either way, make sure every goal turn is productive.';

export class GoalInjection extends Service {
  constructor(
    private readonly options: GoalInjectionOptions,
    injector: IAgentReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      injector.register<GoalReminderDisclosure>('goal', (injection) => this.reminder(injection)),
    );
  }

  private reminder(
    injection: ContextInjectionContext<GoalReminderDisclosure>,
  ): ContextInjectionResult<GoalReminderDisclosure> | undefined {
    if (!injection.isNewTurn) return undefined;
    const goal = this.options.getGoal();
    if (goal === null) return undefined;
    const waitForEnabled = this.options.isWaitForEnabled?.() === true;
    const disclosure = goalDisclosure(goal, waitForEnabled);
    const full =
      goal.status !== 'active' || needsFullGoalReminder(injection, disclosure, this.context.get());
    return {
      content: buildGoalReminder(goal, waitForEnabled, full),
      disclosure,
    };
  }
}

function goalDisclosure(goal: GoalSnapshot, waitForEnabled: boolean): GoalReminderDisclosure {
  return {
    status: goal.status,
    goalId: goal.goalId,
    objective: goal.objective,
    completionCriterion: goal.completionCriterion,
    active: goal.status === 'active',
    budgetBand: isNearingBudget(goal) ? 'nearing' : 'within',
    waitForEnabled,
  };
}

function needsFullGoalReminder(
  injection: ContextInjectionContext<GoalReminderDisclosure>,
  goal: GoalReminderDisclosure,
  history: readonly ContextMessage[],
): boolean {
  const previous = injection.lastDisclosure;
  if (
    injection.injectedPositions.length === 0 ||
    previous === undefined ||
    previous.active !== true ||
    previous.goalId !== goal.goalId ||
    previous.status !== goal.status ||
    previous.objective !== goal.objective ||
    previous.completionCriterion !== goal.completionCriterion ||
    previous.budgetBand !== goal.budgetBand ||
    previous.waitForEnabled !== goal.waitForEnabled
  ) {
    return true;
  }
  return history.slice(injection.lastInjectedAt ?? 0).some(isCompactionSummaryMessage);
}

const BUDGET_GUIDANCE_NEARING =
  'Budget guidance: you are nearing a budget. Converge on the objective and avoid starting new discretionary work.';
const BUDGET_GUIDANCE_WITHIN =
  'Budget guidance: you are within budget. Make steady, focused progress toward the objective.';

function buildGoalReminder(goal: GoalSnapshot, waitForEnabled: boolean, full: boolean): string {
  if (goal.status === 'blocked') {
    return renderPrompt(GOAL_BLOCKED_REMINDER, {
      reason_suffix: reasonSuffix(goal),
      objective: escapeUntrustedText(goal.objective),
      completion_criterion_block: completionCriterionBlock(goal),
    });
  }
  if (goal.status === 'paused') {
    return renderPrompt(GOAL_PAUSED_REMINDER, {
      reason_suffix: reasonSuffix(goal),
      objective: escapeUntrustedText(goal.objective),
      completion_criterion_block: completionCriterionBlock(goal),
    });
  }
  const budgets = formatBudgets(goal);
  return renderPrompt(full ? GOAL_ACTIVE_REMINDER : GOAL_ACTIVE_SPARSE_REMINDER, {
    objective: escapeUntrustedText(goal.objective),
    completion_criterion_block: completionCriterionBlock(goal),
    status: goal.status,
    progress: `${goal.turnsUsed} continuation turns, ${goal.tokensUsed} tokens, ${formatElapsed(goal.wallClockMs)} elapsed`,
    budgets_block: budgets.length > 0 ? `Budgets: ${budgets}.\n` : '',
    budget_guidance: isNearingBudget(goal) ? BUDGET_GUIDANCE_NEARING : BUDGET_GUIDANCE_WITHIN,
    wait_for_guidance: waitForEnabled ? ` ${GOAL_WAIT_FOR_GUIDANCE}` : '',
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
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
