import { grandTotal } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { flags } from '../../flags';
import type { LLM } from '../../loop/llm';
import type { LoopStoppedStepContext, ShouldContinueAfterStopResult } from '../../loop/types';
import {
  GoalEvaluator,
  type GoalEvaluatorInput,
  type GoalEvaluatorResult,
} from './evaluator';

/** Minimal evaluator surface so tests can inject a fake judge. */
export interface GoalEvaluatorLike {
  evaluate(input: GoalEvaluatorInput): Promise<GoalEvaluatorResult>;
}

/**
 * Drives `/goal` autonomous continuation inside a single `TurnFlow.runTurn()`.
 *
 * After a stopped model step, it decides whether the main agent keeps working
 * toward the active goal. It owns per-turn continuation state in memory, hard
 * budget stops, the model self-report (Level-1) terminal decision, and
 * `maxStepsPerTurn` reconciliation. Phase 4d inserts an independent evaluator
 * between the self-report and the continuation prompt.
 */
export interface GoalContinuationControllerOptions {
  /** The outer turn's start timestamp. */
  readonly startedAt: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /**
   * Factory for the per-step evaluator. Defaults to {@link GoalEvaluator} over
   * the step's `llm`; tests inject a fake, and a future lightweight judge model
   * can be selected here.
   */
  readonly createEvaluator?: (llm: LLM) => GoalEvaluatorLike;
}

const CONTINUE: ShouldContinueAfterStopResult = { continue: true };
const STOP: ShouldContinueAfterStopResult = { continue: false };

export class GoalContinuationController {
  private readonly now: () => number;
  private lastWallClockAccountedAt: number;
  private readonly createEvaluator: (llm: LLM) => GoalEvaluatorLike;

  constructor(
    protected readonly agent: Agent,
    options: GoalContinuationControllerOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
    this.lastWallClockAccountedAt = options.startedAt;
    this.createEvaluator = options.createEvaluator ?? ((llm) => new GoalEvaluator({ llm }));
  }

  /** True when goal continuation is eligible to run for this agent. */
  private get enabled(): boolean {
    return flags.enabled('goal-command') && this.agent.type === 'main' && this.agent.goals !== undefined;
  }

  async shouldContinueAfterStop(
    ctx: LoopStoppedStepContext,
  ): Promise<ShouldContinueAfterStopResult> {
    if (!this.enabled) return STOP;
    const store = this.agent.goals!;

    // 1-3. Stop if the goal disappeared, is paused, or is terminal.
    const goal = store.getGoal().goal;
    if (goal === null || goal.status !== 'active') return STOP;

    // This stopped step participated in the goal loop.
    await store.incrementTurn();

    // Record elapsed wall-clock since the last checkpoint before budget checks.
    await this.recordWallClock();

    // Hard budgets (token / turn / wall-clock) before spending an evaluator call.
    const beforeEval = store.getActiveGoal();
    if (beforeEval !== null && beforeEval.budget.overBudget) {
      return this.budgetLimitedWrapUp('A hard budget was reached');
    }

    // Run the independent evaluator. The model's self-report is evidence only.
    const evaluator = this.createEvaluator(ctx.llm);
    const modelReport =
      goal.lastModelReportStatus !== undefined
        ? {
            status: goal.lastModelReportStatus,
            reason: goal.lastModelReportReason,
            evidence: goal.lastModelReportEvidence,
          }
        : undefined;
    const result = await evaluator.evaluate({
      goal,
      messages: this.agent.context.messages,
      modelReport,
      signal: ctx.signal,
    });

    // Count evaluator token usage toward the goal token budget.
    const evaluatorTokens = grandTotal(result.usage);
    if (evaluatorTokens > 0) {
      await store.recordTokenUsage({
        tokenDelta: evaluatorTokens,
        agentId: 'main',
        agentType: 'main',
        source: 'goal_evaluator',
      });
    }

    if (!result.ok) {
      await store.recordEvaluatorFailure({ reason: result.error });
      const failed = store.getActiveGoal();
      if (
        failed !== null &&
        failed.budget.failureTurnLimit !== null &&
        failed.consecutiveFailureTurns >= failed.budget.failureTurnLimit
      ) {
        await store.markError({ reason: 'Goal evaluator failed repeatedly' });
        return STOP;
      }
      // Evaluator tokens may have crossed a hard budget.
      if (failed !== null && failed.budget.overBudget) {
        return this.budgetLimitedWrapUp('A hard budget was reached');
      }
      this.appendContinuationPrompt();
      return CONTINUE;
    }

    await store.recordEvaluatorVerdict({
      verdict: result.verdict,
      reason: result.reason,
      evidence: result.evidence,
    });

    if (
      result.verdict === 'complete' ||
      result.verdict === 'blocked' ||
      result.verdict === 'impossible'
    ) {
      await store.updateGoal({
        status: result.verdict,
        actor: 'evaluator',
        reason: result.reason,
        evidence: result.evidence,
      });
      return STOP;
    }

    // Re-check hard budgets because the evaluator call may have reached the token budget.
    const afterEval = store.getActiveGoal();
    if (afterEval !== null && afterEval.budget.overBudget) {
      return this.budgetLimitedWrapUp('A hard budget was reached');
    }

    // no_progress streak: recordEvaluatorVerdict has already incremented the counter.
    if (
      afterEval !== null &&
      afterEval.budget.noProgressTurnLimit !== null &&
      afterEval.consecutiveNoProgressTurns >= afterEval.budget.noProgressTurnLimit
    ) {
      await store.updateGoal({
        status: 'blocked',
        actor: 'evaluator',
        reason: 'No-progress limit reached',
      });
      return STOP;
    }

    // Reconcile with maxStepsPerTurn so the configured cap is a budget, not an error.
    const maxSteps = this.agent.kimiConfig?.loopControl?.maxStepsPerTurn;
    if (maxSteps !== undefined && maxSteps > 0) {
      const remaining = maxSteps - ctx.stepNumber;
      if (remaining <= 0) {
        // No model step left under the cap: stop without triggering MaxStepsExceededError.
        await store.markBudgetLimited({ reason: 'Model step limit reached' });
        return STOP;
      }
      if (remaining === 1) {
        // Exactly one step left: spend it on a wrap-up, then stop.
        return this.budgetLimitedWrapUp('Model step limit reached');
      }
    }

    // Continue working toward the goal.
    this.appendContinuationPrompt();
    return CONTINUE;
  }

  /**
   * Records the final wall-clock interval when the turn ends or throws. Safe to
   * call once from `TurnFlow.runTurn()`'s `finally`.
   */
  async finalizeWallClock(): Promise<void> {
    if (!this.enabled) return;
    await this.recordWallClock();
  }

  private async recordWallClock(): Promise<void> {
    const now = this.now();
    const delta = now - this.lastWallClockAccountedAt;
    this.lastWallClockAccountedAt = now;
    if (delta > 0) {
      await this.agent.goals?.recordWallClockUsage({ wallClockMs: delta });
    }
  }

  private async budgetLimitedWrapUp(reason: string): Promise<ShouldContinueAfterStopResult> {
    // markBudgetLimited makes the goal terminal, so the next stopped step stops
    // at the status check above — the wrap-up therefore runs exactly once.
    await this.agent.goals!.markBudgetLimited({ reason });
    this.appendBudgetWrapUpPrompt(reason);
    return CONTINUE;
  }

  private appendContinuationPrompt(): void {
    this.agent.context.appendUserMessage(
      [{ type: 'text', text: CONTINUATION_PROMPT }],
      { kind: 'system_trigger', name: 'goal_continuation' },
    );
  }

  private appendBudgetWrapUpPrompt(reason: string): void {
    this.agent.context.appendUserMessage(
      [{ type: 'text', text: budgetWrapUpPrompt(reason) }],
      { kind: 'system_trigger', name: 'goal_continuation' },
    );
  }
}

const CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Use the existing conversation context and your tools. Do not ask the user for input unless a',
  'real blocker prevents progress.',
  'When the goal is complete, blocked, or impossible, call UpdateGoal with a status, a short',
  'reason, and validation evidence when available.',
].join(' ');

function budgetWrapUpPrompt(reason: string): string {
  return [
    `You have reached a goal budget (${reason}).`,
    'Stop starting new substantive work now. Summarize the progress you have made, list the',
    'remaining work, and explain which budget was reached. Then stop.',
  ].join(' ');
}
