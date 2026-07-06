/**
 * `goal` domain (L4) - `IAgentGoalService` implementation.
 *
 * Owns the per-agent goal lifecycle; persists the goal in the `wire`
 * `GoalModel` (`GoalState | null`) through the `goal.create` / `goal.update` /
 * `goal.clear` Ops (`wire.dispatch`), reads it through `wire.getModel`, emits
 * `goal.updated` live through `wire.signal`, and forces a replayed `active`
 * goal back to `paused` via `wire.onRestored`. The accumulated `wallClockMs`
 * lives in the Model (set from each Op payload, never by `Date.now()` inside
 * `apply`); the `wallClockResumedAt` cursor is a live-only field, reset on
 * replay and (re)started on the live path. A `forked` wire Op clears the Model
 * at a fork boundary; the `goal.*` record shapes stay declared in
 * `WireRecordMap` because they still ride the shared wire log read by
 * `getRecords()` and replayed into the Model. Injects reminders through
 * `contextInjector`, drives continuation turns through `turn`, participates in
 * steps through `loop`, updates context through `contextMemory`, writes system
 * reminders through `systemReminder`, registers model tools through
 * `toolRegistry`, and reports telemetry through `telemetry`. Bound at Agent
 * scope.
 */

import { randomUUID } from 'node:crypto';

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import {
  ensureMessageId,
  IAgentContextMemoryService,
  type ContextMessage,
  type PromptOrigin,
} from '#/agent/contextMemory';
import { GoalInjection, type GoalInjectionOptions } from '#/agent/goal/injection/goalInjection';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from '#/agent/goal/tools/outcome-prompts';
import {
  IAgentLoopService,
  type TurnAfterStepContext,
  type TurnBeforeStepContext,
} from '#/agent/loop';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import { IAgentTurnService, type Turn, type TurnEndedContext } from '#/agent/turn';
import type { TokenUsage } from '#/app/llmProtocol';
import type { TelemetryProperties } from '#/app/telemetry';
import { ITelemetryService } from '#/app/telemetry';
import { ErrorCodes, KimiError, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentWireService, type IWireService } from '#/wire';

import { IAgentGoalService, type GoalReasonInput } from './goal';
import { clearGoal, createGoal, GoalModel, updateGoal, type GoalState } from './goalOps';
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from './types';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    forked: {};
    'goal.create': {
      goalId: string;
      objective: string;
      completionCriterion?: string;
    };
    'goal.update': {
      status?: GoalStatus;
      reason?: string;
      turnsUsed?: number;
      tokensUsed?: number;
      wallClockMs?: number;
      budgetLimits?: GoalBudgetLimits;
      actor?: GoalActor;
    };
    'goal.clear': {};
  }
}

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};
const GOAL_COMPLETION_REMINDER_NAME = 'goal_completion_summary';
const GOAL_BLOCKED_REMINDER_NAME = 'goal_blocked_reason';
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';
const GOAL_PROVIDER_FILTERED_PAUSE_REASON = 'Paused after provider safety policy block';
const GOAL_BUDGET_BLOCK_PREFIX = 'Blocked after goal budget reached';
const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far. Goal mode is iterative: do one coherent slice of work, then',
  'reassess. Call UpdateGoal with `complete` only when all required work is done, any stated',
  'validation has passed, and there is no useful next action. Do not mark complete after only',
  'producing a plan, summary, first pass, or partial result. If an external condition or required',
  'user input prevents progress, or the objective cannot be completed as stated, call UpdateGoal',
  'with `blocked`. Otherwise keep going - use the existing conversation context and your tools,',
  'and do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

export interface GoalServiceOptions {
  readonly enabled?: boolean | (() => boolean);
  readonly injection?: GoalInjectionOptions;
}

export class AgentGoalService extends Disposable implements IAgentGoalService {
  declare readonly _serviceBrand: undefined;

  private wallClockResumedAt?: number;
  private readonly goalDrivenTurns = new Set<number>();
  private readonly countedGoalTurns = new Set<number>();
  private readonly goalOutcomeContinuationTurns = new Set<number>();

  constructor(
    private readonly options: GoalServiceOptions = {},
    @IAgentWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentLoopService loopService: IAgentLoopService,
  ) {
    super();
    this._register(
      new GoalInjection(
        options.injection ?? {
          getGoal: () => this.getGoal().goal,
          enabled: () => this.enabled,
        },
        dynamicInjector,
      ),
    );
    // fork clear handled by wire forkGoal op; reminder intentionally dropped (reversible).
    this._register(this.wire.onRestored(() => this.normalizeAfterReplay()));
    this._register(
      turnService.hooks.onLaunched.register('goal-track-launched-turn', (ctx, next) => {
        this.handleTurnLaunched(ctx.turn);
        return next();
      }),
    );
    this._register(
      loopService.hooks.beforeStep.register('goal-count-turn', async (ctx, next) => {
        await this.handleBeforeStep(ctx);
        await next();
      }),
    );
    this._register(
      loopService.hooks.afterStep.register('goal-outcome-continuation', async (ctx, next) => {
        this.handleAfterStep(ctx);
        await next();
      }),
    );
    this._register(
      turnService.hooks.onEnded.register('goal-drive-continuation', async (ctx, next) => {
        await next();
        await this.handleTurnEnded(ctx);
      }),
    );
  }

  get enabled(): boolean {
    const enabled = this.options.enabled;
    return typeof enabled === 'function' ? enabled() : enabled !== false;
  }

  private get goalState(): GoalState | null {
    return this.wire.getModel(GoalModel) as GoalState | null;
  }

  getGoal(): GoalToolResult {
    const state = this.goalState;
    return { goal: state === null ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const objective = input.objective.trim();
    if (objective.length === 0) {
      throw new KimiError(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new KimiError(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters`,
      );
    }

    if (this.goalState !== null) {
      if (input.replace !== true) {
        throw new KimiError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      this.clearInternal('system');
    }

    this.wire.dispatch(
      createGoal({
        goalId: randomUUID(),
        objective,
        completionCriterion: normalizeCompletionCriterion(input.completionCriterion),
      }),
    );
    this.wallClockResumedAt = Date.now();
    const state = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(state));
    this.telemetry.track('goal_created', { actor, replace: input.replace === true });
    return this.toSnapshot(state);
  }

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new KimiError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    return this.applyLifecycle(state, 'paused', input.reason, actor);
  }

  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    return this.applyLifecycle(state, 'paused', input.reason, actor);
  }

  async resumeGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new KimiError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    return this.applyLifecycle(state, 'active', input.reason, actor);
  }

  async setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    const budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.wire.dispatch(updateGoal({ budgetLimits }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next));
    this.telemetry.track('goal_budget_set', {
      actor,
      ...budgetTelemetryProperties(input.budgetLimits),
    });
    return this.blockIfBudgetReached(next) ?? this.toSnapshot(next);
  }

  async cancelGoal(_input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.clearInternal(actor);
    if (actor === 'user') {
      this.reminders.appendSystemReminder(GOAL_CANCELLED_REMINDER, {
        kind: 'system_trigger',
        name: 'goal_cancelled',
      });
    }
    return snapshot;
  }

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    const snapshot = this.applyLifecycle(state, 'blocked', input.reason, actor);
    if (actor === 'model') {
      this.reminders.appendSystemReminder(buildGoalBlockedReasonPrompt(snapshot), {
        kind: 'system_trigger',
        name: GOAL_BLOCKED_REMINDER_NAME,
      });
    }
    return snapshot;
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    const wallClockMs = this.settleWallClock(state);
    this.wallClockResumedAt = undefined;
    this.wire.dispatch(
      updateGoal({ status: 'complete', reason: input.reason, wallClockMs, actor }),
    );
    const completed = this.requireState();
    const snapshot = this.toSnapshot(completed);
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(completed),
      actor,
    });
    this.trackStatusChanged(completed, actor);
    if (actor === 'model') {
      this.reminders.appendSystemReminder(buildGoalCompletionSummaryPrompt(snapshot), {
        kind: 'system_trigger',
        name: GOAL_COMPLETION_REMINDER_NAME,
      });
    }
    this.clearInternal(actor);
    return snapshot;
  }

  async pauseOnInterrupt(input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    return this.accountTokenUsage(tokenDelta);
  }

  private accountTokenUsage(tokenDelta: number): GoalSnapshot | null {
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    const tokensUsed = state.tokensUsed + Math.max(0, tokenDelta);
    this.wire.dispatch(updateGoal({ tokensUsed }));
    const next = this.requireState();
    return this.blockIfBudgetReached(next) ?? this.toSnapshot(next);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    const turnsUsed = state.turnsUsed + 1;
    this.wire.dispatch(updateGoal({ turnsUsed }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next));
    this.telemetry.track('goal_continued', { turns_used: next.turnsUsed });
    return this.blockIfBudgetReached(next) ?? this.toSnapshot(next);
  }

  private handleTurnLaunched(turn: Turn): void {
    const turnId = turn.id;
    if (this.goalState?.status === 'active') this.goalDrivenTurns.add(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);
  }

  private async handleBeforeStep(ctx: TurnBeforeStepContext): Promise<void> {
    if (!this.goalDrivenTurns.has(ctx.turnId)) return;
    if (this.countedGoalTurns.has(ctx.turnId)) return;
    this.countedGoalTurns.add(ctx.turnId);
    await this.incrementTurn();
  }

  private handleAfterStep(ctx: TurnAfterStepContext): void {
    if (this.goalDrivenTurns.has(ctx.turnId)) {
      const snapshot = this.accountTokenUsage(tokenUsageTotal(ctx.usage));
      if (snapshot?.budget.overBudget === true) {
        // Over budget: account the usage but do not continue this turn. Note this
        // runs after the step's tools have already executed (the old
        // `onStepUsage` hook could stop before tools); it now only suppresses
        // further continuation.
        return;
      }
    }
    if (this.goalOutcomeContinuationTurns.has(ctx.turnId)) return;
    if (!isGoalOutcomeReminder(this.context.get().at(-1))) return;
    this.goalOutcomeContinuationTurns.add(ctx.turnId);
    ctx.continue = true;
  }

  private async handleTurnEnded(ctx: TurnEndedContext): Promise<void> {
    const turnId = ctx.turn.id;
    this.goalDrivenTurns.delete(turnId);
    this.countedGoalTurns.delete(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);

    if (ctx.result.reason === 'blocked') {
      await this.markBlocked({ reason: 'Blocked by UserPromptSubmit hook' });
      return;
    }

    if (ctx.result.reason === 'cancelled') {
      await this.pauseOnInterrupt({ reason: 'Paused after interruption' });
      return;
    }
    if (ctx.result.reason === 'failed') {
      await this.pauseActiveGoal({ reason: goalFailurePauseReason(ctx.result.error) });
      return;
    }

    const state = this.goalState;
    if (state === null || state.status !== 'active') return;
    if (this.blockIfBudgetReached(state) !== null) return;
    if (this.turnService.getActiveTurn() !== undefined) return;
    this.launchContinuationTurn();
  }

  private launchContinuationTurn(): void {
    const message = ensureMessageId({
      role: 'user',
      content: [{ type: 'text', text: GOAL_CONTINUATION_PROMPT }],
      toolCalls: [],
      origin: GOAL_CONTINUATION_ORIGIN,
    });
    this.context.splice(this.context.get().length, 0, [message]);
    this.turnService.launch();
  }

  private normalizeAfterReplay(): void {
    const state = this.goalState;
    if (state === null) return;
    this.wallClockResumedAt = undefined;
    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }
    if (state.status !== 'active') return;

    const reason = 'Paused after agent resume';
    this.wire.dispatch(
      updateGoal({
        status: 'paused',
        reason,
        wallClockMs: this.settleWallClock(state),
        actor: 'runtime',
      }),
    );
    this.trackStatusChanged(this.requireState(), 'runtime');
  }

  private clearInternal(
    actor: GoalActor,
    opts: { readonly emit?: boolean; readonly track?: boolean } = {},
  ): void {
    if (this.goalState === null) return;
    this.wallClockResumedAt = undefined;
    this.wire.dispatch(clearGoal({}));
    if (opts.emit !== false) this.emitGoalUpdated(null);
    if (opts.track !== false) this.telemetry.track('goal_cleared', { actor });
  }

  private applyLifecycle(
    state: GoalState,
    status: GoalStatus,
    reason: string | undefined,
    actor: GoalActor,
  ): GoalSnapshot {
    const wallClockMs = this.settleWallClock(state);
    if (status === 'active') {
      this.wallClockResumedAt = Date.now();
    } else if (state.status === 'active') {
      this.wallClockResumedAt = undefined;
    }
    this.wire.dispatch(updateGoal({ status, reason, wallClockMs, actor }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next), { kind: 'lifecycle', status, reason, actor });
    this.trackStatusChanged(next, actor);
    return this.toSnapshot(next);
  }

  private trackStatusChanged(state: GoalState, actor: GoalActor): void {
    this.telemetry.track('goal_status_changed', {
      actor,
      status: state.status,
      turns_used: state.turnsUsed,
      tokens_used: state.tokensUsed,
      wall_clock_ms: this.liveWallClockMs(state),
      ...budgetTelemetryProperties(state.budgetLimits),
    });
  }

  private requireState(): GoalState {
    const state = this.goalState;
    if (state === null) {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.wire.signal({ type: 'goal.updated', snapshot, change });
  }

  private settleWallClock(state: GoalState): number {
    if (state.status === 'active' && this.wallClockResumedAt !== undefined) {
      return state.wallClockMs + Math.max(0, Date.now() - this.wallClockResumedAt);
    }
    return state.wallClockMs;
  }

  private liveWallClockMs(state: GoalState): number {
    if (state.status === 'active' && this.wallClockResumedAt !== undefined) {
      return state.wallClockMs + Math.max(0, Date.now() - this.wallClockResumedAt);
    }
    return state.wallClockMs;
  }

  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: this.liveWallClockMs(state),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    const wallClockMs = this.liveWallClockMs(state);
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs,
      budget: computeBudgetReport(state, wallClockMs),
      terminalReason: state.terminalReason,
    };
  }

  private blockIfBudgetReached(state: GoalState): GoalSnapshot | null {
    if (state.status !== 'active') return null;
    const reason = goalBudgetBlockReason(this.toSnapshot(state).budget);
    if (reason === undefined) return null;
    return this.applyLifecycle(state, 'blocked', reason, 'runtime');
  }
}

function computeBudgetReport(state: GoalState, wallClockMs: number): GoalBudgetReport {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached = wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

function goalBudgetBlockReason(budget: GoalBudgetReport): string | undefined {
  const reached: string[] = [];
  if (budget.turnBudgetReached) {
    reached.push(`turn budget ${budget.turnBudget ?? ''}`.trim());
  }
  if (budget.tokenBudgetReached) {
    reached.push(`token budget ${budget.tokenBudget ?? ''}`.trim());
  }
  if (budget.wallClockBudgetReached) {
    reached.push(`wall-clock budget ${budget.wallClockBudgetMs ?? ''}ms`.trim());
  }
  return reached.length === 0 ? undefined : `${GOAL_BUDGET_BLOCK_PREFIX}: ${reached.join(', ')}`;
}

function budgetTelemetryProperties(limits: GoalBudgetLimits): TelemetryProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

function isGoalOutcomeReminder(message: ContextMessage | undefined): boolean {
  if (message?.origin?.kind !== 'system_trigger') return false;
  return (
    message.origin.name === GOAL_COMPLETION_REMINDER_NAME ||
    message.origin.name === GOAL_BLOCKED_REMINDER_NAME
  );
}

function goalFailurePauseReason(error: unknown): string {
  const payload = normalizeGoalErrorPayload(error);
  switch (payload.code) {
    case ErrorCodes.PROVIDER_RATE_LIMIT:
      return GOAL_RATE_LIMIT_PAUSE_REASON;
    case ErrorCodes.PROVIDER_CONNECTION_ERROR:
      return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, payload.message);
    case ErrorCodes.PROVIDER_AUTH_ERROR:
      return pauseReasonWithMessage(GOAL_PROVIDER_AUTH_PAUSE_PREFIX, payload.message);
    case ErrorCodes.PROVIDER_FILTERED:
      return GOAL_PROVIDER_FILTERED_PAUSE_REASON;
    case ErrorCodes.PROVIDER_API_ERROR:
      return pauseReasonWithMessage(GOAL_PROVIDER_API_PAUSE_PREFIX, payload.message);
    case ErrorCodes.MODEL_NOT_CONFIGURED:
      return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, LLM_NOT_SET_MESSAGE);
    case ErrorCodes.MODEL_CONFIG_INVALID:
      return pauseReasonWithMessage(GOAL_MODEL_CONFIG_PAUSE_PREFIX, payload.message);
    default:
      return pauseReasonWithMessage(GOAL_RUNTIME_PAUSE_PREFIX, payload.message);
  }
}

function normalizeGoalErrorPayload(error: unknown): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  if (payload.code === ErrorCodes.MODEL_NOT_CONFIGURED) {
    return { ...payload, message: LLM_NOT_SET_MESSAGE };
  }
  return payload;
}

function pauseReasonWithMessage(prefix: string, message: string | undefined): string {
  const trimmed = message?.trim();
  return trimmed === undefined || trimmed.length === 0 ? prefix : `${prefix}: ${trimmed}`;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentGoalService,
  AgentGoalService,
  InstantiationType.Eager,
  'goal',
);
