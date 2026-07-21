/**
 * `goal` domain (L4) — `IAgentGoalService` implementation.
 *
 * Owns the main-agent goal lifecycle; persists the goal in the `wire`
 * `GoalModel` (`GoalState | null`) through the `goal.create` / `goal.update` /
 * `goal.clear` Ops (`wire.dispatch`), reads it through `wire.getModel`,
 * publishes `goal.updated` live to `IEventBus`, and forces a replayed `active`
 * goal back to `paused` via `wire.hooks.onDidRestore`. The accumulated
 * `wallClockMs` lives in the Model (set from each Op payload, never by
 * `Date.now()` inside `apply`); the active interval's epoch-ms
 * `wallClockResumedAt` anchor is
 * persisted at create/resume boundaries so recovery can settle crash-spanning
 * elapsed time without periodic writes. A `forked` wire Op clears the Model
 * at a fork boundary; the `goal.*` payload shapes are registered in
 * `PersistedOpMap` (`#/wire/types`) inside `goalOps` because they still ride
 * the Agent wire journal restored into the Model.
 * Injects reminders through
 * `contextInjector`, drives continuation turns by enqueueing `newTurn`
 * `StepRequest`s onto `loop` (the continuation message materializes when the
 * loop pops it), accounts live
 * turn usage through `usage`, observes terminal goal tool results through
 * `toolExecutor`, writes system reminders through `systemReminder`, reports
 * telemetry through `telemetry`, and checks main-agent eligibility through
 * `scopeContext`. Measures time and arms hard deadlines through `goal`'s
 * App-scoped deadline scheduler. Bound at Agent scope.
 * Subagent instances reject every goal command and do not install goal
 * injection, accounting, budget, or continuation hooks.
 */

import { randomUUID } from 'node:crypto';

import type { TurnEndedEvent, TurnStartedEvent } from '#/agent/loop/turnEvents';
import { Disposable, MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { abortError } from '#/_base/utils/abort';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { GoalInjection } from '#/agent/goal/injection/goalInjection';
import { tryNativeGoalApplyUpdate, tryNativeGoalRenderBudgetLimit, tryNativeGoalRenderContinuation } from '#/_base/native-tools';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type EnqueueReceipt,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { ContinuationStepRequest, MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ToolBeforeExecuteContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentUsageService, type UsageRecordedContext } from '#/agent/usage/usage';
import { inputTotal, type TokenUsage } from '#/app/llmProtocol/usage';
import type { GoalBudgetProperties } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IConfigService } from '#/app/config/config';
import {
  ErrorCodes,
  Error2,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from '#/errors';
import { IWireService } from '#/wire/wire';
import { defineModel } from '#/wire/model';
import { IEventBus } from '#/app/event/eventBus';

import { IAgentGoalService, type GoalReasonInput, type ResumeGoalInput } from './goal';
import { IGoalDeadlineScheduler } from './goalDeadlineScheduler';
import { clearGoal, createGoal, GoalModel, updateGoal, type GoalState } from './goalOps';
import type {
  CreateGoalInput,
  GoalAccountingMode,
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
} from './types';

import { t } from '@moonshot-ai/kimi-i18n';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH;

/** Minimum completionCriterion length to reject placeholders and empty strings. */
const MIN_GOAL_COMPLETION_CRITERION_LENGTH = 10;

const GOAL_CANCELLED_REMINDER = t('v2Goal.cancelledReminder');

const GOAL_FORK_CLEARED_REMINDER = t('v2Goal.forkClearedReminder');

const GOAL_FORK_CLEARED_REMINDER_NAME = 'goal_fork_cleared';

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};
const GOAL_RATE_LIMIT_PAUSE_REASON = t('v2Goal.pausedRateLimit');
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = t('v2Goal.pausedConnectionError');
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = t('v2Goal.pausedAuthError');
const GOAL_PROVIDER_API_PAUSE_PREFIX = t('v2Goal.pausedApiError');
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = t('v2Goal.pausedModelConfig');
const GOAL_RUNTIME_PAUSE_PREFIX = t('v2Goal.pausedRuntime');
const GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX = t('v2Goal.pausedContinuationFailure');
const GOAL_PROVIDER_FILTERED_PAUSE_REASON = t('v2Goal.pausedProviderFiltered');
const GOAL_BUDGET_BLOCK_PREFIX = t('v2Goal.budgetLimited');
const LLM_NOT_SET_MESSAGE = t('v2Goal.llmNotSet');

const GOAL_BUDGET_STOP_REMINDER_NAME = 'goal_budget_stop';

const GOAL_BUDGET_STOP_REMINDER = t('v2Goal.budgetStopReminder');

const GOAL_BUDGET_TOOLS_REJECTED_MESSAGE = t('v2Goal.budgetToolsRejected');
const GOAL_STALE_TOOL_RESULT = t('v2Goal.staleToolResult');

const GOAL_CONTINUATION_PROMPT_FALLBACK = t('v2Goal.continuationPromptFallback');

function buildGoalContinuationPrompt(goal: {
  objective: string;
  tokensUsed: number;
  tokenBudget?: number | null;
}): string {
  const nativePrompt = tryNativeGoalRenderContinuation(
    goal.objective,
    goal.tokensUsed,
    goal.tokenBudget ?? null,
  );
  if (nativePrompt !== undefined) return nativePrompt;
  return GOAL_CONTINUATION_PROMPT_FALLBACK;
}

interface GoalForkNoticeState {
  readonly goalPresent: boolean;
  readonly reminderPending: boolean;
}

interface PendingContinuation {
  readonly receipt: EnqueueReceipt;
  readonly goalId: string;
  turnId?: number;
}

const GoalForkNoticeModel = defineModel<GoalForkNoticeState>(
  'goalForkNotice',
  () => ({ goalPresent: false, reminderPending: false }),
  {
    reducers: {
      'goal.create': (state) => ({ ...state, goalPresent: true }),
      'goal.clear': (state) => ({ ...state, goalPresent: false }),
      forked: (state) => ({
        goalPresent: false,
        reminderPending: state.goalPresent || state.reminderPending,
      }),
      'context.append_message': (state, payload: { message?: ContextMessage }) =>
        state.reminderPending && isGoalForkClearedReminder(payload.message)
          ? { ...state, reminderPending: false }
          : state,
    },
  },
);

function isGoalForkClearedReminder(message: ContextMessage | undefined): boolean {
  return (
    message?.origin?.kind === 'system_trigger' &&
    message.origin.name === GOAL_FORK_CLEARED_REMINDER_NAME
  );
}

function isGoalContinuationOrigin(origin: TurnStartedEvent['origin']): boolean {
  return origin.kind === 'system_trigger' && origin.name === 'goal_continuation';
}

export class AgentGoalService extends Disposable implements IAgentGoalService {
  declare readonly _serviceBrand: undefined;

  private liveTurnId?: number;
  private readonly goalDrivenTurns = new Map<number, string>();
  private readonly countedGoalTurns = new Set<number>();
  private readonly goalStarterTurns = new Set<number>();
  private readonly goalOutcomeToolResultTurns = new Map<number, string>();
  private readonly goalOutcomeContinuationTurns = new Set<number>();
  private readonly budgetGraceTurns = new Set<number>();
  private readonly pendingContinuationGoals = new Map<number, string>();
  private readonly goalTurnTargets = new Map<number, string>();
  private readonly exhaustedTurnBudgetGoals = new Map<number, string>();
  /** In-memory blocked streak counter per goal. Resets on resume. */
  private readonly blockedStreakMap = new Map<string, number>();
  private readonly accountingMode: GoalAccountingMode = 'active_status_only';
  private readonly wallClockDeadline = this._register(new MutableDisposable<IDisposable>());
  private liveWallClockStartedAt?: number;
  private pendingContinuation?: PendingContinuation;
  private resumeContinuation?: { readonly turnId: number; readonly goalId: string };

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentUsageService usageService: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @IGoalDeadlineScheduler private readonly deadlineScheduler: IGoalDeadlineScheduler,
    @IAgentScopeContext private readonly agentContext: IAgentScopeContext,
  ) {
    super();
    if (!this.isSupportedAgent) return;
    this._register(
      new GoalInjection(
        {
          getGoal: () => this.getGoal().goal,
        },
        dynamicInjector,
      ),
    );
    this._register(
      this.wire.hooks.onDidRestore.register('goal', async (_ctx, next) => {
        this.normalizeAfterReplay();
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.started', (e) => {
        this.handleTurnLaunched(e.turnId, e.origin);
      }),
    );
    this._register(
      usageService.onDidRecord((ctx) => this.handleUsageRecorded(ctx)),
    );
    this._register(
      loopService.hooks.onWillBeginStep.register('goal-count-turn', async (ctx, next) => {
        await this.handleBeforeStep(ctx);
        await next();
      }),
    );
    this._register(
      loopService.hooks.onDidFinishStep.register('goal-outcome-continuation', async (ctx, next) => {
        this.handleAfterStep(ctx);
        await next();
      }),
    );
    this._register(
      toolExecutor.hooks.onBeforeExecuteTool.register('goal-budget-reject', async (ctx, next) => {
        if (this.isStaleGoalToolCall(ctx)) {
          ctx.decision = { syntheticResult: { output: GOAL_STALE_TOOL_RESULT } };
          return;
        }
        if (this.budgetGraceTurns.has(ctx.turnId)) {
          ctx.decision = {
            syntheticResult: { output: GOAL_BUDGET_TOOLS_REJECTED_MESSAGE },
          };
          return;
        }
        await next();
      }),
    );
    this._register(
      toolExecutor.hooks.onDidExecuteTool.register('goal-outcome-tool-result', async (ctx, next) => {
        const goalId = this.goalTurnTarget(ctx.turnId);
        if (
          goalId !== undefined &&
          isTerminalUpdateGoalResult(ctx.toolCall.name, ctx.args, ctx.result)
        ) {
          this.goalOutcomeToolResultTurns.set(ctx.turnId, goalId);
        }
        await next();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', (e) => {
        const goalId = this.goalTurnTarget(e.turnId);
        void this.handleTurnEnded(e.turnId, { reason: e.reason, error: e.error }).catch((error) =>
          this.settleGoalAfterContinuationFailure(error, goalId),
        );
      }),
    );
  }

  private get isSupportedAgent(): boolean {
    return this.agentContext.agentId === 'main';
  }

  private assertSupportedAgent(): void {
    if (this.isSupportedAgent) return;
    throw new Error2(
      ErrorCodes.GOAL_UNSUPPORTED_AGENT,
      t('v2Goal.onlyMainAgent'),
      { details: { agentId: this.agentContext.agentId } },
    );
  }

  private get goalState(): GoalState | null {
    return this.wire.getModel(GoalModel) as GoalState | null;
  }

  getGoal(): GoalToolResult {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null) return { goal: null };
    const snapshot = this.toSnapshot(state);
    // Merge in-memory blockedStreak (wire model doesn't update synchronously)
    const memStreak = this.blockedStreakMap.get(state.goalId);
    if (memStreak !== undefined && (snapshot.blockedStreak ?? 0) < memStreak) {
      return { goal: { ...snapshot, blockedStreak: memStreak } };
    }
    return { goal: snapshot };
  }

  isGoalToolTarget(turnId: number, goalId: string): boolean {
    this.assertSupportedAgent();
    return this.goalTurnTargets.get(turnId) === goalId;
  }

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const objective = this.validateObjective(input.objective);
    const completionCriterion = normalizeCompletionCriterion(
      this.validateCompletionCriterion(input.completionCriterion),
    );
    this.prepareForGoalCreation(input.replace === true);
    const wallClockResumedAt = Date.now();
    this.wire.dispatch(
      createGoal({
        goalId: randomUUID(),
        objective,
        completionCriterion,
        wallClockResumedAt,
      }),
    );
    this.liveWallClockStartedAt = this.deadlineScheduler.now();
    this.adoptStarterTurn(actor);
    const state = this.requireState();
    this.refreshWallClockDeadline(state);
    this.emitGoalUpdated(this.toSnapshot(state));
    this.telemetry.track2('goal_created', { actor, replace: input.replace === true });
    return this.toSnapshot(state);
  }

  private validateObjective(value: string): string {
    const objective = value.trim();
    if (objective.length === 0) {
      throw new Error2(ErrorCodes.GOAL_OBJECTIVE_EMPTY, t('v2Goal.objectiveCannotBeEmpty'));
    }
    if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
      throw new Error2(
        ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
        t('v2Goal.objectiveTooLong', { max: String(MAX_GOAL_OBJECTIVE_LENGTH) }),
      );
    }
    return objective;
  }

  private validateCompletionCriterion(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const criterion = value.trim();
    if (criterion.length === 0) {
      throw new Error2(ErrorCodes.GOAL_COMPLETION_CRITERION_EMPTY, t('v2Goal.completionCriterionEmpty'));
    }
    if (criterion.length < MIN_GOAL_COMPLETION_CRITERION_LENGTH) {
      throw new Error2(
        ErrorCodes.GOAL_COMPLETION_CRITERION_TOO_SHORT,
        t('v2Goal.completionCriterionTooShort', { min: String(MIN_GOAL_COMPLETION_CRITERION_LENGTH) }),
      );
    }
    return criterion;
  }

  private prepareForGoalCreation(replace: boolean): void {
    if (this.goalState === null) return;
    if (!replace) {
      throw new Error2(
        ErrorCodes.GOAL_ALREADY_EXISTS,
        t('v2Goal.goalAlreadyExistsReplace'),
      );
    }
    this.clearInternal('system');
  }

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new Error2(
        ErrorCodes.GOAL_STATUS_INVALID,
        t('v2Goal.cannotPause', { status: state.status }),
      );
    }
    return this.applyLifecycle(state, 'paused', input.reason, actor);
  }

  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    const pausable: GoalStatus[] = ['active', 'budget_limited', 'usage_limited'];
    if (state === null || !pausable.includes(state.status)) return null;
    return this.applyLifecycle(state, 'paused', input.reason, actor);
  }

  /** Transition goal to `usage_limited` — API usage cap reached.
   *  Allowed from: active, budget_limited (Codex compat). */
  async usageLimitActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    const limitable: GoalStatus[] = ['active', 'budget_limited'];
    if (state === null || !limitable.includes(state.status)) return null;
    return this.applyLifecycle(state, 'usage_limited', input.reason, actor, { preserveLiveContinuation: true });
  }

  async resumeGoal(input: ResumeGoalInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new Error2(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        t('v2Goal.cannotResume', { status: state.status }),
      );
    }
    const continuePaused =
      actor === 'user' && state.status === 'paused' && input.continueIfPaused === true;
    const shouldContinue =
      continuePaused ||
      (actor === 'user' && state.status === 'blocked' && input.continueIfBlocked === true);
    const snapshot = this.applyLifecycle(state, 'active', input.reason, actor);
    // Clear in-memory blocked streak on resume
    this.blockedStreakMap.delete(state.goalId);
    if (!shouldContinue) return snapshot;
    const budgetBlocked = this.blockIfBudgetReached(this.requireState());
    if (budgetBlocked !== null) return budgetBlocked;
    if (this.canLaunchContinuation()) {
      try {
        this.launchContinuationTurn(state.goalId);
      } catch (error) {
        await this.settleGoalAfterContinuationFailure(error, state.goalId);
        throw error;
      }
    } else if (continuePaused && this.liveTurnId !== undefined) {
      this.resumeContinuation = { turnId: this.liveTurnId, goalId: state.goalId };
    }
    return snapshot;
  }

  async setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    const budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.wire.dispatch(updateGoal({ budgetLimits }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next));
    this.telemetry.track2('goal_budget_set', {
      actor,
      ...budgetTelemetryProperties(input.budgetLimits),
    });
    const blocked = this.blockIfBudgetReached(next);
    if (blocked !== null) return blocked;
    this.refreshWallClockDeadline(next);
    return this.toSnapshot(next);
  }

  async cancelGoal(_input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    this.assertSupportedAgent();
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    if (state.status === 'active' && this.liveTurnId !== undefined) {
      this.loopService.cancel(this.liveTurnId);
    }
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
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    const snapshot = this.applyLifecycle(state, 'blocked', input.reason, actor, {
      preserveLiveContinuation: true,
    });
    return snapshot;
  }

  async markBudgetLimited(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    const snapshot = this.applyLifecycle(state, 'budget_limited', input.reason, actor, {
      preserveLiveContinuation: true,
    });
    return snapshot;
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (state === null || state.status !== 'active') return null;
    this.dispatchCompletion(state, input.reason, actor);
    const completed = this.requireState();
    const snapshot = this.toSnapshot(completed);
    this.emitCompletion(completed, snapshot, input.reason, actor);
    this.trackStatusChanged(completed, actor);
    this.clearInternal(actor, { preserveLiveContinuation: true });
    return snapshot;
  }

  private dispatchCompletion(state: GoalState, reason: string | undefined, actor: GoalActor): void {
    const wallClockMs = this.settleWallClock(state);
    this.wire.dispatch(updateGoal({ status: 'complete', reason, wallClockMs, actor }));
  }

  private emitCompletion(
    state: GoalState,
    snapshot: GoalSnapshot,
    reason: string | undefined,
    actor: GoalActor,
  ): void {
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason,
      stats: this.statsOf(state),
      actor,
    });
  }

  async pauseOnInterrupt(input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    return this.pauseActiveGoal(input, 'user');
  }

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    return this.accountTokenUsage(tokenDelta);
  }

  /**
   * Returns true when the goal state is eligible for usage accounting
   * under the current {@link accountingMode}.
   */
  private isAccountingActive(state: GoalState | null): boolean {
    if (state === null) return false;
    switch (this.accountingMode) {
      case 'active_status_only':
        return state.status === 'active';
      case 'active_only':
        return state.status === 'active' || state.status === 'budget_limited';
      case 'active_or_complete':
        return state.status === 'active' || state.status === 'budget_limited' || state.status === 'complete';
      case 'active_or_stopped':
        return state.status !== 'complete';
      default:
        return state.status === 'active';
    }
  }

  /** Temporarily set the accounting mode (returns a restore function). */
  private withAccountingMode(mode: GoalAccountingMode): () => void {
    const prev = this.accountingMode;
    (this as { accountingMode: GoalAccountingMode }).accountingMode = mode;
    return () => {
      (this as { accountingMode: GoalAccountingMode }).accountingMode = prev;
    };
  }

  private accountTokenUsage(usage: TokenUsage, goalId?: string): GoalSnapshot | null {
    const state = this.goalState;
    if (!this.isAccountingActive(state) || !matchesGoal(state, goalId)) return null;
    const inputDelta = Math.max(0, inputTotal(usage));
    const outputDelta = Math.max(0, usage.output);
    const totalDelta = inputDelta + outputDelta;
    if (totalDelta === 0) return this.toSnapshot(this.requireState());
    this.wire.dispatch(
      updateGoal({
        tokensUsed: state.tokensUsed + totalDelta,
        inputTokensUsed: state.inputTokensUsed + inputDelta,
        outputTokensUsed: state.outputTokensUsed + outputDelta,
      }),
    );
    const next = this.requireState();
    return this.blockIfBudgetReached(next) ?? this.toSnapshot(next);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    return this.incrementGoalTurn();
  }

  async recordBlockedAttempt(): Promise<GoalSnapshot | null> {
    this.assertSupportedAgent();
    const state = this.goalState;
    if (!this.isAccountingActive(state)) return null;
    // blockedStreak is tracked via a local in-memory counter because wire
    // model dispatches are append-log based and don't update the model
    // synchronously for subsequent reads in the same turn.
    const currentKey = state.goalId;
    const currentStreak = this.blockedStreakMap.get(currentKey) ?? 0;
    const newStreak = currentStreak + 1;
    this.blockedStreakMap.set(currentKey, newStreak);
    const snapshot = this.toSnapshot(state);
    return { ...snapshot, blockedStreak: newStreak } as GoalSnapshot;
  }

  /** In-memory blocked streak counter per goal. Resilient to resume (cleared there). */

  private incrementGoalTurn(goalId?: string): GoalSnapshot | null {
    const state = this.goalState;
    if (!this.isAccountingActive(state) || !matchesGoal(state, goalId)) return null;
    const turnsUsed = state.turnsUsed + 1;
    this.wire.dispatch(updateGoal({ turnsUsed }));
    const next = this.requireState();
    this.emitGoalUpdated(this.toSnapshot(next));
    this.telemetry.track2('goal_continued', { turns_used: next.turnsUsed });
    return this.toSnapshot(next);
  }

  private handleTurnLaunched(turnId: number, origin: TurnStartedEvent['origin']): void {
    this.liveTurnId = turnId;
    this.goalTurnTargets.delete(turnId);
    this.exhaustedTurnBudgetGoals.delete(turnId);
    if (!this.goalDrivenTurns.has(turnId)) {
      const state = this.goalState;
      const continuationGoalId = isGoalContinuationOrigin(origin)
        ? this.pendingContinuationGoals.get(turnId)
        : undefined;
      if (continuationGoalId !== undefined && state?.goalId !== continuationGoalId) {
        this.goalDrivenTurns.set(turnId, continuationGoalId);
      } else if (state?.status === 'active' && this.blockIfBudgetReached(state) === null) {
        this.goalDrivenTurns.set(turnId, state.goalId);
      }
    }
    this.pendingContinuationGoals.delete(turnId);
    this.goalOutcomeToolResultTurns.delete(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);
  }

  private adoptStarterTurn(actor: GoalActor): void {
    const turnId = this.liveTurnId;
    if (turnId === undefined) return;
    const state = this.goalState;
    if (state === null || state.status !== 'active') return;
    const goalId = this.goalDrivenTurns.get(turnId);
    if (actor === 'model') this.goalTurnTargets.set(turnId, state.goalId);
    if (this.toSnapshot(state).budget.turnBudgetReached) {
      this.exhaustedTurnBudgetGoals.set(turnId, state.goalId);
    } else {
      this.exhaustedTurnBudgetGoals.delete(turnId);
    }
    if (goalId !== undefined) return;
    this.goalDrivenTurns.set(turnId, state.goalId);
    this.countedGoalTurns.add(turnId);
    this.goalStarterTurns.add(turnId);
  }

  private async handleBeforeStep(ctx: BeforeStepContext): Promise<void> {
    const goalId = this.goalDrivenTurns.get(ctx.turnId);
    if (goalId === undefined) return;
    if (this.countedGoalTurns.has(ctx.turnId)) return;
    this.countedGoalTurns.add(ctx.turnId);
    this.incrementGoalTurn(goalId);
  }

  private handleUsageRecorded(ctx: UsageRecordedContext): void {
    const source = ctx.source;
    if (source?.type !== 'turn') return;
    const goalId = this.goalDrivenTurns.get(source.turnId);
    if (goalId === undefined) return;
    this.accountTokenUsage(ctx.usage, goalId);
  }

  private handleAfterStep(ctx: AfterStepContext): void {
    if (this.stopAfterBudgetReached(ctx)) return;
    this.enqueueGoalOutcomeContinuation(ctx);
  }

  private stopAfterBudgetReached(ctx: AfterStepContext): boolean {
    const goalId = this.goalTurnTarget(ctx.turnId);
    const state = this.goalState;
    const budget = state === null ? null : this.toSnapshot(state).budget;
    const turnBudgetBlocksCurrentTurn =
      budget?.turnBudgetReached === true &&
      (this.exhaustedTurnBudgetGoals.get(ctx.turnId) === goalId ||
        (state?.status === 'budget_limited' &&
          state.terminalReason?.startsWith(GOAL_BUDGET_BLOCK_PREFIX) === true));
    if (
      goalId === undefined ||
      state === null ||
      state.goalId !== goalId ||
      budget === null ||
      (!budget.tokenBudgetReached &&
        !budget.wallClockBudgetReached &&
        !turnBudgetBlocksCurrentTurn)
    ) {
      return false;
    }
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (
      ctx.finishReason === 'tool_calls' &&
      !this.budgetGraceTurns.has(ctx.turnId) &&
      hasStepBudgetRemaining(maxSteps, ctx.step)
    ) {
      this.budgetGraceTurns.add(ctx.turnId);
      // Render the budget_limit prompt using native when available
      const budgetPrompt = tryNativeGoalRenderBudgetLimit(
        state.objective,
        state.tokensUsed,
        state.tokenBudget ?? null,
        Math.floor(state.wallClockMs / 1000),
      );
      this.reminders.appendSystemReminder(budgetPrompt ?? GOAL_BUDGET_STOP_REMINDER, {
        kind: 'system_trigger',
        name: GOAL_BUDGET_STOP_REMINDER_NAME,
      });
      return true;
    }
    ctx.stopTurn = true;
    return true;
  }

  private enqueueGoalOutcomeContinuation(ctx: AfterStepContext): void {
    if (this.goalOutcomeContinuationTurns.has(ctx.turnId)) return;
    const goalId = this.goalTurnTarget(ctx.turnId);
    const outcomeGoalId = this.goalOutcomeToolResultTurns.get(ctx.turnId);
    this.goalOutcomeToolResultTurns.delete(ctx.turnId);
    if (goalId === undefined || outcomeGoalId !== goalId) return;
    const state = this.goalState;
    if (state !== null && state.goalId !== goalId) return;
    this.goalOutcomeContinuationTurns.add(ctx.turnId);
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (!hasStepBudgetRemaining(maxSteps, ctx.step)) return;
    this.loopService.enqueue(new ContinuationStepRequest());
  }

  private async handleTurnEnded(
    turnId: number,
    result: Pick<TurnEndedEvent, 'reason' | 'error'>,
  ): Promise<void> {
    const { goalId, lifecycleGoalId, starterTurn } = this.clearTurnTracking(turnId);
    const resumeContinuation = this.resumeContinuation;
    if (resumeContinuation?.turnId === turnId) this.resumeContinuation = undefined;
    if (resumeContinuation?.turnId === turnId && result.reason === 'cancelled') {
      const state = this.goalState;
      if (state === null || state.status !== 'active' || state.goalId !== resumeContinuation.goalId) {
        return;
      }
      if (this.blockIfBudgetReached(state) !== null) return;
      this.launchContinuationTurn(resumeContinuation.goalId);
      return;
    }
    if (goalId === undefined || lifecycleGoalId === undefined) return;
    if (
      result.reason === 'blocked' ||
      result.reason === 'cancelled' ||
      result.reason === 'failed'
    ) {
      const restore = this.withAccountingMode('active_or_stopped');
      await this.settleAbnormalTurn(result, lifecycleGoalId);
      restore();
      return;
    }
    const restore = this.withAccountingMode('active_or_complete');
    if (starterTurn) this.incrementGoalTurn(goalId);

    const state = this.goalState;
    if (state === null || state.status !== 'active' || state.goalId !== lifecycleGoalId) {
      restore();
      return;
    }
    if (this.blockIfBudgetReached(state) !== null) {
      restore();
      return;
    }
    this.launchContinuationTurn(lifecycleGoalId);
    restore();
  }

  private clearTurnTracking(
    turnId: number,
  ): {
    readonly goalId?: string;
    readonly lifecycleGoalId?: string;
    readonly starterTurn: boolean;
  } {
    if (this.pendingContinuation?.turnId === turnId) this.pendingContinuation = undefined;
    if (this.liveTurnId === turnId) this.liveTurnId = undefined;
    const goalId = this.goalDrivenTurns.get(turnId);
    const lifecycleGoalId = this.goalTurnTarget(turnId);
    const starterTurn = this.goalStarterTurns.delete(turnId);
    this.goalDrivenTurns.delete(turnId);
    this.countedGoalTurns.delete(turnId);
    this.goalOutcomeToolResultTurns.delete(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);
    this.budgetGraceTurns.delete(turnId);
    this.pendingContinuationGoals.delete(turnId);
    this.goalTurnTargets.delete(turnId);
    this.exhaustedTurnBudgetGoals.delete(turnId);
    return { goalId, lifecycleGoalId, starterTurn };
  }

  private async settleAbnormalTurn(
    result: Pick<TurnEndedEvent, 'reason' | 'error'>,
    goalId: string,
  ): Promise<boolean> {
    if (!this.isActiveGoal(goalId)) return false;
    if (result.reason === 'blocked') {
      await this.markBlocked({ reason: t('v2Goal.blockedByHook') });
      return true;
    }
    if (result.reason === 'cancelled') {
      await this.pauseOnInterrupt({ reason: t('v2Goal.pausedAfterInterruption') });
      return true;
    }
    if (result.reason === 'failed') {
      await this.pauseActiveGoal({ reason: goalFailurePauseReason(result.error) });
      return true;
    }
    return false;
  }

  private async settleGoalAfterContinuationFailure(
    error: unknown,
    goalId: string | undefined,
  ): Promise<void> {
    if (goalId === undefined || !this.isActiveGoal(goalId)) return;
    try {
      const reason = pauseReasonWithMessage(
        GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX,
        normalizeGoalErrorPayload(error).message,
      );
      await this.pauseActiveGoal({ reason }, 'system');
    } catch {}
  }

  private launchContinuationTurn(goalId: string): void {
    if (!this.isActiveGoal(goalId)) return;
    if (this.pendingContinuation !== undefined) return;
    const goal = this.wire.getModel(GoalModel);
    const prompt = goal
      ? buildGoalContinuationPrompt({
          objective: goal.objective,
          tokensUsed: goal.tokensUsed,
          tokenBudget: goal.tokenBudget,
        })
      : GOAL_CONTINUATION_PROMPT_FALLBACK;
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      toolCalls: [],
      origin: GOAL_CONTINUATION_ORIGIN,
    };
    const request = new MessageStepRequest(message, {
      kind: 'goal_continuation',
      admission: 'newTurn',
    });
    const receipt = this.loopService.enqueue(request);
    const pending: PendingContinuation = { receipt, goalId };
    this.pendingContinuation = pending;
    void receipt.assigned
      .then(({ turn }) => {
        pending.turnId = turn.id;
        if (!this.goalDrivenTurns.has(turn.id)) {
          this.pendingContinuationGoals.set(turn.id, pending.goalId);
        }
        return turn.result;
      })
      .finally(() => {
        if (pending.turnId !== undefined) this.pendingContinuationGoals.delete(pending.turnId);
        if (this.pendingContinuation === pending) this.pendingContinuation = undefined;
      });
  }

  private canLaunchContinuation(): boolean {
    if (this.liveTurnId !== undefined || this.pendingContinuation !== undefined) return false;
    const status = this.loopService.status();
    return status.state === 'idle' && !status.hasPendingRequests;
  }

  private isActiveGoal(goalId: string): boolean {
    const state = this.goalState;
    return state?.status === 'active' && state.goalId === goalId;
  }

  private isStaleGoalToolCall(ctx: ToolBeforeExecuteContext): boolean {
    const toolName = ctx.toolCall.name;
    if (!isGoalMutationTool(toolName)) return false;
    const goalId = this.goalTurnTarget(ctx.turnId);
    if (goalId === undefined) return false;
    return this.goalState?.goalId !== goalId;
  }

  private goalTurnTarget(turnId: number): string | undefined {
    return this.goalTurnTargets.get(turnId) ?? this.goalDrivenTurns.get(turnId);
  }

  private cancelPendingContinuation(
    preserveLiveContinuation = false,
    reason?: unknown,
  ): void {
    const pending = this.pendingContinuation;
    if (preserveLiveContinuation && pending?.turnId === this.liveTurnId) return;
    this.pendingContinuation = undefined;
    const aborted =
      reason === undefined ? pending?.receipt.abort() : pending?.receipt.abort(reason);
    if (
      pending !== undefined &&
      !aborted &&
      pending.turnId !== undefined
    ) {
      if (reason === undefined) {
        this.loopService.cancel(pending.turnId);
      } else {
        this.loopService.cancel(pending.turnId, reason);
      }
    }
  }

  private normalizeAfterReplay(): void {
    this.appendForkClearedReminder();
    this.wallClockDeadline.clear();
    this.liveWallClockStartedAt = undefined;
    const state = this.goalState;
    if (state === null) return;
    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }
    if (state.status !== 'active') return;

    const reason = t('v2Goal.pausedAfterResume');
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

  private appendForkClearedReminder(): void {
    if (!this.wire.getModel(GoalForkNoticeModel).reminderPending) return;
    this.reminders.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, {
      kind: 'system_trigger',
      name: GOAL_FORK_CLEARED_REMINDER_NAME,
    });
  }

  private clearInternal(
    actor: GoalActor,
    opts: { readonly emit?: boolean; readonly track?: boolean; readonly preserveLiveContinuation?: boolean } = {},
  ): void {
    if (this.goalState === null) return;
    this.resumeContinuation = undefined;
    this.cancelPendingContinuation(opts.preserveLiveContinuation === true);
    this.wallClockDeadline.clear();
    this.liveWallClockStartedAt = undefined;
    this.wire.dispatch(clearGoal({}));
    if (opts.emit !== false) this.emitGoalUpdated(null);
    if (opts.track !== false) this.telemetry.track2('goal_cleared', { actor });
  }

  private applyLifecycle(
    state: GoalState,
    status: GoalStatus,
    reason: string | undefined,
    actor: GoalActor,
    opts: {
      readonly preserveLiveContinuation?: boolean;
      readonly cancellationReason?: unknown;
    } = {},
  ): GoalSnapshot {
    // Validate transition through native when available
    this.tryNativeValidateTransition(state, status);

    const wallClockMs = this.settleWallClock(state);
    const wallClockResumedAt = status === 'active' ? Date.now() : undefined;
    if (status === 'active') {
      this.liveWallClockStartedAt = this.deadlineScheduler.now();
    } else if (state.status === 'active') {
      this.resumeContinuation = undefined;
      this.cancelPendingContinuation(
        opts.preserveLiveContinuation === true,
        opts.cancellationReason,
      );
      this.wallClockDeadline.clear();
      this.liveWallClockStartedAt = undefined;
    }
    this.wire.dispatch(
      updateGoal({ status, reason, wallClockMs, wallClockResumedAt, actor }),
    );
    const next = this.requireState();
    if (status === 'active') this.adoptStarterTurn(actor);
    if (status === 'active') this.refreshWallClockDeadline(next);
    this.emitGoalUpdated(this.toSnapshot(next), { kind: 'lifecycle', status, reason, actor });
    this.trackStatusChanged(next, actor);
    return this.toSnapshot(next);
  }

  private trackStatusChanged(state: GoalState, actor: GoalActor): void {
    this.telemetry.track2('goal_status_changed', {
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
      throw new Error2(ErrorCodes.GOAL_NOT_FOUND, t('v2Goal.noCurrentGoal'));
    }
    return state;
  }

  /**
   * Validates a state transition through the native Rust module (best-effort).
   * If native is available and rejects the transition (e.g. wrong expected_goal_id),
   * the mutation will still proceed through TS logic (TS is the source of truth).
   * This is a secondary validation / telemetry aid.
   */
  private tryNativeValidateTransition(state: GoalState, newStatus: GoalStatus): void {
    const goalJson = JSON.stringify({
      goalId: state.goalId,
      objective: state.objective,
      status: state.status,
      tokenBudget: state.budgetLimits.tokenBudget ?? null,
      tokensUsed: state.tokensUsed,
      timeUsedSeconds: Math.floor(state.wallClockMs / 1000),
      blockedStreak: state.blockedStreak ?? 0,
    });
    const updateJson = JSON.stringify({
      status: newStatus,
      expectedGoalId: state.goalId,
    });
    // Returns undefined if native unavailable — silently ignored
    tryNativeGoalApplyUpdate(goalJson, updateJson);
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.eventBus.publish({ type: 'goal.updated', snapshot, change });
  }

  private settleWallClock(state: GoalState): number {
    if (state.status === 'active' && this.liveWallClockStartedAt !== undefined) {
      return (
        state.wallClockMs +
        Math.max(0, this.deadlineScheduler.now() - this.liveWallClockStartedAt)
      );
    }
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      return state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt);
    }
    return state.wallClockMs;
  }

  private liveWallClockMs(state: GoalState): number {
    if (state.status === 'active' && this.liveWallClockStartedAt !== undefined) {
      return (
        state.wallClockMs +
        Math.max(0, this.deadlineScheduler.now() - this.liveWallClockStartedAt)
      );
    }
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      return state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt);
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
      inputTokensUsed: state.inputTokensUsed,
      outputTokensUsed: state.outputTokensUsed,
      wallClockMs,
      budget: computeBudgetReport(state, wallClockMs),
      terminalReason: state.terminalReason,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }

  private blockIfBudgetReached(state: GoalState): GoalSnapshot | null {
    if (state.status !== 'active') return null;
    const reason = goalBudgetBlockReason(this.toSnapshot(state).budget);
    if (reason === undefined) return null;
    // Budget exhaustion sets budget_limited (not blocked) so the model may
    // produce one final wrap-up message. budget_limited is not resumable
    // without a new budget.
    return this.applyLifecycle(state, 'budget_limited', reason, 'runtime', {
      preserveLiveContinuation: true,
    });
  }

  private refreshWallClockDeadline(state: GoalState): void {
    this.wallClockDeadline.clear();
    const budgetMs = state.budgetLimits.wallClockBudgetMs;
    if (
      state.status !== 'active' ||
      budgetMs === undefined ||
      this.liveWallClockStartedAt === undefined
    ) {
      return;
    }
    const remainingMs = Math.max(0, budgetMs - this.liveWallClockMs(state));
    this.wallClockDeadline.value = this.deadlineScheduler.schedule(remainingMs, () => {
      this.handleWallClockDeadline();
    });
  }

  private handleWallClockDeadline(): void {
    this.wallClockDeadline.clear();
    const state = this.goalState;
    if (state === null || state.status !== 'active') return;
    const budgetMs = state.budgetLimits.wallClockBudgetMs;
    if (budgetMs === undefined) return;
    if (this.liveWallClockMs(state) < budgetMs) {
      this.refreshWallClockDeadline(state);
      return;
    }
    const reason = goalBudgetBlockReason(this.toSnapshot(state).budget);
    if (reason === undefined) return;
    const cancellation = abortError(reason);
    const liveTurnId = this.liveTurnId;
    const pendingTurnId = this.pendingContinuation?.turnId;
    this.applyLifecycle(state, 'budget_limited', reason, 'runtime', {
      cancellationReason: cancellation,
    });
    if (liveTurnId !== undefined && liveTurnId !== pendingTurnId) {
      this.loopService.cancel(liveTurnId, cancellation);
    }
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
    inputTokensUsed: state.inputTokensUsed,
    outputTokensUsed: state.outputTokensUsed,
  };
}

function matchesGoal(state: GoalState, goalId: string | undefined): boolean {
  return goalId === undefined || state.goalId === goalId;
}

function isGoalMutationTool(toolName: string): boolean {
  return toolName === 'CreateGoal' || toolName === 'UpdateGoal' || toolName === 'SetGoalBudget';
}

function goalBudgetBlockReason(budget: GoalBudgetReport): string | undefined {
  const reached: string[] = [];
  if (budget.turnBudgetReached) {
    reached.push('turn');
  }
  if (budget.tokenBudgetReached) {
    reached.push('token');
  }
  if (budget.wallClockBudgetReached) {
    reached.push('wall-clock');
  }
  if (reached.length === 0) return undefined;
  return t('v2Goal.budgetBlockReason', {
    budgets: reached.join(', '),
    turnBudget: budget.turnBudget ?? '',
    tokenBudget: budget.tokenBudget ?? '',
    wallClockBudget: budget.wallClockBudgetMs ?? '',
  });
}

function budgetTelemetryProperties(limits: GoalBudgetLimits): GoalBudgetProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed?.length) return undefined;
  return trimmed.length > MAX_GOAL_COMPLETION_CRITERION_LENGTH
    ? trimmed.slice(0, MAX_GOAL_COMPLETION_CRITERION_LENGTH)
    : trimmed;
}

function hasStepBudgetRemaining(maxSteps: number | undefined, currentStep: number): boolean {
  return maxSteps === undefined || maxSteps <= 0 || currentStep < maxSteps;
}

function isTerminalUpdateGoalResult(
  toolName: string,
  args: unknown,
  result: ExecutableToolResult,
): boolean {
  if (toolName !== 'UpdateGoal' || result.isError === true || result.stopTurn !== true) {
    return false;
  }
  if (!isPlainRecord(args)) return false;
  const status = args['status'];
  return status === 'complete' || status === 'blocked';
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
