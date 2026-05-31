import { grandTotal } from '@moonshot-ai/kosong';

import type { Agent } from '..';
import { flags } from '../../flags';
import type { LLM } from '../../loop/llm';
import type {
  LoopMaxStepsContext,
  LoopStoppedStepContext,
  MaxStepsDecision,
  ShouldContinueAfterStopResult,
} from '../../loop/types';
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

// Continuing always restarts the per-turn step budget so `maxStepsPerTurn`
// bounds one continuation segment, not the entire goal run.
const CONTINUE: MaxStepsDecision = { continue: true, resetStepBudget: true };
const STOP: MaxStepsDecision = { continue: false };

export class GoalContinuationController {
  private readonly now: () => number;
  private lastWallClockAccountedAt: number;
  private readonly createEvaluator: (llm: LLM) => GoalEvaluatorLike;
  // True once goal continuation has driven this turn. Lets a step-budget cap hit
  // *after* the goal went terminal (e.g. during a budget wrap-up where the model
  // kept working instead of summarizing) stop the turn gracefully instead of
  // throwing loop.max_steps_exceeded.
  private engaged = false;

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

  /** Runs after a stopped (terminal) model step. */
  async shouldContinueAfterStop(
    ctx: LoopStoppedStepContext,
  ): Promise<ShouldContinueAfterStopResult> {
    if (!this.enabled) return STOP;
    return this.decide(ctx.llm, ctx.signal);
  }

  /**
   * Runs when the per-turn step budget is exhausted mid-segment. For an active
   * goal it treats the cap as a continuation checkpoint — the same
   * evaluator-driven decision as a normal stop. If the goal already went
   * terminal earlier in *this* turn (e.g. a budget wrap-up and the model kept
   * calling tools instead of summarizing), the cap stops the turn gracefully.
   * Otherwise (no goal, or a stale terminal goal from a resumed session) it
   * returns `undefined` so the loop throws `MaxStepsExceededError` as usual.
   */
  async shouldContinueOnMaxSteps(ctx: LoopMaxStepsContext): Promise<MaxStepsDecision | undefined> {
    if (!this.enabled) return undefined;
    const goal = this.agent.goals!.getGoal().goal;
    if (goal !== null && goal.status === 'active') return this.decide(ctx.llm, ctx.signal);
    // Goal terminal or gone: only suppress the fatal throw if goal continuation
    // already drove this turn (the wrap-up case).
    return this.engaged ? STOP : undefined;
  }

  /**
   * The shared goal-continuation decision, used by both the normal stop hook and
   * the step-budget checkpoint. Increments the goal turn, accounts wall-clock,
   * enforces hard budgets, runs the evaluator, and applies the verdict.
   */
  private async decide(llm: LLM, signal: AbortSignal): Promise<MaxStepsDecision> {
    if (!this.enabled) return STOP;
    const store = this.agent.goals!;

    // Stop if the goal disappeared, is paused, or is terminal.
    const goal = store.getGoal().goal;
    if (goal === null || goal.status !== 'active') return STOP;

    // Goal continuation is now driving this turn; a later cap (e.g. during a
    // budget wrap-up) must stop gracefully rather than throw.
    this.engaged = true;

    // This stopped step / checkpoint participated in the goal loop.
    await store.incrementTurn();

    // Record elapsed wall-clock since the last checkpoint before budget checks.
    await this.recordWallClock();

    // Hard budgets (token / turn / wall-clock) before spending an evaluator call.
    const beforeEval = store.getActiveGoal();
    if (beforeEval !== null && beforeEval.budget.overBudget) {
      return this.block('A configured budget was reached');
    }

    // Run the independent evaluator. The model's self-report is evidence only.
    const evaluator = this.createEvaluator(llm);
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
      signal,
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
        return this.block('The goal evaluator failed repeatedly');
      }
      // Evaluator tokens may have crossed a hard budget.
      if (failed !== null && failed.budget.overBudget) {
        return this.block('A configured budget was reached');
      }
      return this.continueToward();
    }

    await store.recordEvaluatorVerdict({
      verdict: result.verdict,
      reason: result.reason,
      evidence: result.evidence,
    });

    // Success: complete + clear (the store announces; the box disappears).
    if (result.verdict === 'complete') {
      await store.markComplete({
        actor: 'evaluator',
        reason: result.reason,
        evidence: result.evidence,
      });
      return STOP;
    }

    // The evaluator judged the goal cannot proceed (incl. objectives it deems
    // unachievable — there is no separate `impossible`): block with its reason.
    if (result.verdict === 'blocked') {
      await store.markBlocked({
        actor: 'evaluator',
        reason: result.reason,
        evidence: result.evidence,
      });
      return STOP;
    }

    // Re-check hard budgets because the evaluator call may have reached the token budget.
    const afterEval = store.getActiveGoal();
    if (afterEval !== null && afterEval.budget.overBudget) {
      return this.block('A configured budget was reached');
    }

    // no_progress streak: recordEvaluatorVerdict has already incremented the counter.
    if (
      afterEval !== null &&
      afterEval.budget.noProgressTurnLimit !== null &&
      afterEval.consecutiveNoProgressTurns >= afterEval.budget.noProgressTurnLimit
    ) {
      return this.block(`No progress after ${afterEval.budget.noProgressTurnLimit} turns`);
    }

    // `maxStepsPerTurn` is no longer reconciled here: it bounds a single
    // continuation segment (run-turn resets the budget on each continue) and a
    // mid-segment cap is handled as a checkpoint via shouldContinueOnMaxSteps.
    // The goal's own budgets (turn / token / wall-clock) remain the ceiling.

    // Continue working toward the goal.
    return this.continueToward();
  }

  /**
   * Continue working toward the goal at this continuation boundary: re-inject a
   * fresh goal-context reminder (append-only, so prompt caching is preserved)
   * and append the continuation prompt.
   */
  private async continueToward(): Promise<MaxStepsDecision> {
    await this.agent.injection.injectGoal();
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

  /**
   * Stop pursuing the goal: mark it `blocked` with `reason` and end the turn.
   * `blocked` is resumable (`/goal resume`), so this is not a dead end — the user
   * can refine the goal, raise a budget, or resume. `markBlocked` no-ops if the
   * goal is no longer active, so this is safe to call at any checkpoint.
   */
  private async block(reason: string): Promise<MaxStepsDecision> {
    await this.agent.goals!.markBlocked({ reason });
    return STOP;
  }

  private appendContinuationPrompt(): void {
    this.agent.context.appendUserMessage(
      [{ type: 'text', text: CONTINUATION_PROMPT }],
      { kind: 'system_trigger', name: 'goal_continuation' },
    );
  }
}

const CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'First, briefly self-audit: weigh the objective and any completion criteria against the work done',
  'so far. If the goal is complete, call UpdateGoal with status `complete`, a short reason, and',
  'validation evidence when available — then stop. If an external condition or required user input',
  'prevents progress, call UpdateGoal with status `blocked` and a short reason. Otherwise keep going.',
  'Use the existing conversation context and your tools. Do not ask the user for input unless a real',
  'blocker prevents progress.',
].join(' ');
