import { randomUUID } from 'node:crypto';

import {
  Disposable,
  registerSingleton,
  SyncDescriptor,
} from "#/_base/di";
import { ErrorCodes, KimiError } from "#/_base/errors";
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
} from '../../../agent/goal';
import type { TelemetryProperties } from '../../../telemetry';
import { IContextMemory } from '../contextMemory/contextMemory';
import { IEventBus } from '../eventBus/eventBus';
import { IReplayBuilderService } from '../replayBuilder/replayBuilder';
import { ITelemetryService } from '../telemetry/telemetry';
import type { ContextMessage, WireRecord } from '../types';
import { IWireRecord } from '../wireRecord/wireRecord';
import { IDynamicInjector } from '../dynamicInjector/dynamicInjector';
import {
  GoalInjection,
  type GoalInjectionOptions,
} from '../goalMode/injection/goalInjection';
import {
  IGoalService,
  type GoalReasonInput,
} from './goal';

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const GOAL_CANCELLED_REMINDER = [
  'The user cancelled the current goal.',
  'Ignore earlier active-goal reminders for that goal.',
  'Handle the next user request normally unless the user starts or resumes a goal.',
].join(' ');

const GOAL_FORK_CLEARED_REMINDER = [
  'This fork does not have a current goal.',
  'Ignore earlier active-goal reminders from the source session.',
  'Handle requests normally unless the user starts a new goal.',
].join(' ');

export interface GoalServiceOptions {
  readonly enabled?: boolean | (() => boolean);
  readonly injection?: GoalInjectionOptions;
}

interface GoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  wallClockResumedAt?: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
}

export class GoalService extends Disposable implements IGoalService {
  declare readonly _serviceBrand: undefined;

  private state: GoalState | undefined;

  constructor(
    private readonly options: GoalServiceOptions = {},
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IEventBus private readonly events: IEventBus,
    @IContextMemory private readonly context: IContextMemory,
    @IReplayBuilderService private readonly replayBuilder: IReplayBuilderService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IDynamicInjector dynamicInjector: IDynamicInjector,
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
    this._register(
      wireRecord.register('forked', (record) => {
        this.restoreForked(record);
      }),
    );
    this._register(
      wireRecord.register('goal.create', (record) => {
        this.restoreCreate(record);
      }),
    );
    this._register(
      wireRecord.register('goal.update', (record) => {
        this.restoreUpdate(record);
      }),
    );
    this._register(
      wireRecord.register('goal.clear', () => {
        this.restoreClear();
      }),
    );
    this._register(
      wireRecord.hooks.onResumeEnded.register('goal-normalize-after-replay', async (_ctx, next) => {
        await next();
        this.normalizeAfterReplay();
      }),
    );
  }

  get enabled(): boolean {
    const enabled = this.options.enabled;
    return typeof enabled === 'function' ? enabled() : enabled !== false;
  }

  getGoal(): GoalToolResult {
    const state = this.state;
    return { goal: state === undefined ? null : this.toSnapshot(state) };
  }

  getActiveGoal(): GoalSnapshot | null {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    return this.toSnapshot(state);
  }

  async createGoal(
    input: CreateGoalInput,
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
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

    if (this.state !== undefined) {
      if (input.replace !== true) {
        throw new KimiError(
          ErrorCodes.GOAL_ALREADY_EXISTS,
          'A goal already exists; use replace to start a new one',
        );
      }
      this.clearInternal('system');
    }

    const state: GoalState = {
      goalId: randomUUID(),
      objective,
      completionCriterion: normalizeCompletionCriterion(input.completionCriterion),
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      wallClockResumedAt: Date.now(),
      budgetLimits: {},
    };

    this.persistState(state);
    this.wireRecord.append({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
    });
    this.track('goal_created', { actor, replace: input.replace === true });
    return this.toSnapshot(state);
  }

  async pauseGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'paused') return this.toSnapshot(state);
    if (state.status !== 'active') {
      throw new KimiError(
        ErrorCodes.GOAL_STATUS_INVALID,
        `Cannot pause a goal in status "${state.status}"`,
      );
    }
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async pauseActiveGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'paused');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'paused', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async resumeGoal(
    input: GoalReasonInput = {},
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    if (state.status === 'active') return this.toSnapshot(state);
    if (state.status !== 'paused' && state.status !== 'blocked') {
      throw new KimiError(
        ErrorCodes.GOAL_NOT_RESUMABLE,
        `Cannot resume a goal in status "${state.status}"`,
      );
    }
    state.terminalReason = undefined;
    this.applyStatus(state, 'active');
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'active', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    const state = this.requireState();
    state.budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
    this.persistState(state);
    this.appendGoalUpdate({ budgetLimits: state.budgetLimits });
    this.track('goal_budget_set', {
      actor,
      ...budgetTelemetryProperties(input.budgetLimits),
    });
    return this.toSnapshot(state);
  }

  async cancelGoal(actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    const state = this.requireState();
    const snapshot = this.toSnapshot(state);
    this.clearInternal(actor);
    if (actor === 'user') {
      this.appendSystemReminder(GOAL_CANCELLED_REMINDER, 'goal_cancelled');
    }
    return snapshot;
  }

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'blocked');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    return this.toSnapshot(state);
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'complete');
    state.terminalReason = input.reason;
    const snapshot = this.toSnapshot(state);
    this.appendStatusUpdate(state, actor, input.reason);
    this.emitGoalUpdated(snapshot, {
      kind: 'completion',
      status: 'complete',
      reason: input.reason,
      stats: this.statsOf(state),
      actor,
    });
    this.clearInternal(actor);
    return snapshot;
  }

  async pauseOnInterrupt(input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
    return this.pauseActiveGoal(input, 'user');
  }

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.tokensUsed += Math.max(0, tokenDelta);
    this.persistState(state, { silent: true });
    this.appendGoalUpdate({ tokensUsed: state.tokensUsed });
    return this.toSnapshot(state);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    this.persistState(state);
    this.appendGoalUpdate({ turnsUsed: state.turnsUsed });
    this.track('goal_continued', { turns_used: state.turnsUsed });
    return this.toSnapshot(state);
  }

  private normalizeAfterReplay(): void {
    const state = this.state;
    if (state === undefined) return;
    state.wallClockResumedAt = undefined;
    if (state.status === 'complete') {
      this.clearInternal('runtime', { emit: false, track: false });
      return;
    }
    if (state.status !== 'active') return;

    const reason = 'Paused after agent resume';
    this.applyStatus(state, 'paused');
    state.terminalReason = reason;
    this.persistState(state, { silent: true });
    this.appendStatusUpdate(state, 'runtime', reason);
  }

  private restoreCreate(record: WireRecord<'goal.create'>): void {
    const state: GoalState = {
      goalId: record.goalId,
      objective: record.objective,
      completionCriterion: record.completionCriterion,
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
    };
    this.state = state;
    this.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change: { kind: 'created' },
    });
  }

  private restoreUpdate(record: WireRecord<'goal.update'>): void {
    const state = this.state;
    if (state === undefined) return;

    const status = record.status;
    if (status !== undefined) {
      state.status = status;
      state.wallClockResumedAt = undefined;
      state.terminalReason = status === 'active' ? undefined : record.reason;
    }
    if (record.turnsUsed !== undefined) state.turnsUsed = record.turnsUsed;
    if (record.tokensUsed !== undefined) state.tokensUsed = record.tokensUsed;
    if (record.wallClockMs !== undefined) {
      state.wallClockMs = record.wallClockMs;
      state.wallClockResumedAt = undefined;
    }
    if (record.budgetLimits !== undefined) state.budgetLimits = record.budgetLimits;
    if (status === undefined) return;

    this.replayBuilder.push({
      type: 'goal_updated',
      snapshot: this.toSnapshot(state),
      change:
        status === 'complete'
          ? {
              kind: 'completion',
              status,
              reason: record.reason,
              stats: this.statsOf(state),
              actor: record.actor,
            }
          : {
              kind: 'lifecycle',
              status,
              reason: record.reason,
              actor: record.actor,
            },
    });
  }

  private restoreClear(): void {
    this.state = undefined;
  }

  private restoreForked(_record: WireRecord<'forked'>): void {
    const hadGoal = this.state !== undefined;
    this.state = undefined;
    if (!hadGoal) return;
    this.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, 'goal_fork_cleared');
  }

  private clearInternal(
    actor: GoalActor,
    opts: { readonly emit?: boolean; readonly track?: boolean } = {},
  ): void {
    if (this.state === undefined) return;
    this.persistState(undefined, { silent: opts.emit === false });
    this.wireRecord.append({ type: 'goal.clear' });
    if (opts.track !== false) this.track('goal_cleared', { actor });
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, reason?: string): void {
    this.appendGoalUpdate({
      status: state.status,
      reason,
      wallClockMs: liveWallClockMs(state),
      actor,
    });
    this.track('goal_status_changed', {
      actor,
      status: state.status,
      turns_used: state.turnsUsed,
      tokens_used: state.tokensUsed,
      wall_clock_ms: liveWallClockMs(state),
      ...budgetTelemetryProperties(state.budgetLimits),
    });
  }

  private appendGoalUpdate(
    update: Omit<WireRecord<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.wireRecord.append({
      type: 'goal.update',
      ...update,
    });
  }

  private applyStatus(state: GoalState, status: GoalStatus): void {
    const now = Date.now();
    if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
      state.wallClockMs += Math.max(0, now - state.wallClockResumedAt);
      state.wallClockResumedAt = undefined;
    }
    if (status === 'active') {
      state.wallClockResumedAt = now;
    }
    state.status = status;
  }

  private requireState(): GoalState {
    const state = this.state;
    if (state === undefined) {
      throw new KimiError(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
    }
    return state;
  }

  private persistState(
    state: GoalState | undefined,
    opts: { readonly silent?: boolean; readonly change?: GoalChange } = {},
  ): void {
    this.state = state;
    if (opts.silent !== true) {
      this.emitGoalUpdated(state === undefined ? null : this.toSnapshot(state), opts.change);
    }
  }

  private emitGoalUpdated(snapshot: GoalSnapshot | null, change?: GoalChange): void {
    this.events.emit({ type: 'goal.updated', snapshot, change });
  }

  private statsOf(state: GoalState): GoalChangeStats {
    return {
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state),
    };
  }

  private toSnapshot(state: GoalState): GoalSnapshot {
    return {
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
      status: state.status,
      turnsUsed: state.turnsUsed,
      tokensUsed: state.tokensUsed,
      wallClockMs: liveWallClockMs(state),
      budget: computeBudgetReport(state),
      terminalReason: state.terminalReason,
    };
  }

  private track(event: string, properties: TelemetryProperties): void {
    this.telemetry.track(event, properties);
  }

  private appendSystemReminder(text: string, name: string): void {
    const message: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: `<system-reminder>\n${text}\n</system-reminder>` }],
      toolCalls: [],
      origin: { kind: 'system_trigger', name },
    };
    this.context.spliceHistory(this.context.getHistory().length, 0, [message]);
  }
}

function liveWallClockMs(state: GoalState, now: number = Date.now()): number {
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, now - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function computeBudgetReport(
  state: GoalState,
  now: number = Date.now(),
): GoalBudgetReport {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;
  const wallClockMs = liveWallClockMs(state, now);

  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;

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

function budgetTelemetryProperties(limits: GoalBudgetLimits): TelemetryProperties {
  return {
    has_token_budget: limits.tokenBudget !== undefined,
    has_turn_budget: limits.turnBudget !== undefined,
    has_wall_clock_budget: limits.wallClockBudgetMs !== undefined,
  };
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : undefined;
}

registerSingleton(
  IGoalService,
  new SyncDescriptor(GoalService, [{}], true),
);
