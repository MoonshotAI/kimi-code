/**
 * `goal` domain (L4) - `IAgentGoalService` implementation.
 *
 * Owns the per-agent goal lifecycle; persists records and broadcasts through
 * `record`, injects reminders through `contextInjector`, drives continuation
 * turns through `turn`, participates in steps through `loop`, updates context
 * through `contextMemory`, writes system reminders through `systemReminder`,
 * registers model tools through `toolRegistry`, and reports telemetry through
 * `telemetry`. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';
import type { TokenUsage } from '@moonshot-ai/kosong';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { Disposable } from "#/_base/di";
import {
  ErrorCodes,
  KimiError,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from "#/errors";
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import {
  ensureMessageId,
  IAgentContextMemoryService,
  type ContextMessage,
  type PromptOrigin,
} from '#/agent/contextMemory';
import {
  IAgentLoopService,
  type TurnAfterStepContext,
  type TurnBeforeStepContext,
  type TurnStepUsageContext,
} from '#/agent/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode';
import { IAgentReplayBuilderService } from '#/agent/replayBuilder';
import { IAgentSystemReminderService } from '#/agent/systemReminder';
import {
  IAgentTurnService,
  type Turn,
  type TurnEndedContext,
} from '#/agent/turn';
import type { TelemetryProperties } from '#/app/telemetry';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IAgentRecordService, type AgentRecord } from '#/agent/record';
import {
  IAgentGoalService,
  type GoalReasonInput,
} from './goal';
import {
  GoalInjection,
  type GoalInjectionOptions,
} from '#/agent/goal/injection/goalInjection';
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
import { CreateGoalTool } from '#/agent/goal/tools/create-goal';
import { GetGoalTool } from '#/agent/goal/tools/get-goal';
import {
  buildGoalBlockedReasonPrompt,
  buildGoalCompletionSummaryPrompt,
} from '#/agent/goal/tools/outcome-prompts';
import { SetGoalBudgetTool } from '#/agent/goal/tools/set-goal-budget';
import { UpdateGoalTool } from '#/agent/goal/tools/update-goal';

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

const GOAL_FORK_CLEARED_REMINDER = [
  'This fork does not have a current goal.',
  'Ignore earlier active-goal reminders from the source session.',
  'Handle requests normally unless the user starts a new goal.',
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

export class AgentGoalService extends Disposable implements IAgentGoalService {
  declare readonly _serviceBrand: undefined;

  private state: GoalState | undefined;
  private readonly goalDrivenTurns = new Set<number>();
  private readonly countedGoalTurns = new Set<number>();
  private readonly goalOutcomeContinuationTurns = new Set<number>();
  private readonly promptHookBlockedTurns = new Set<number>();

  constructor(
    private readonly options: GoalServiceOptions = {},
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentReplayBuilderService private readonly replayBuilder: IAgentReplayBuilderService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentTurnService private readonly turnService: IAgentTurnService,
    @IAgentLoopService loopService: IAgentLoopService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentPermissionModeService private readonly permissionMode: IAgentPermissionModeService,
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
      record.define('forked', {
        resume: (r) => {
          this.restoreForked(r);
        },
      }),
    );
    this._register(
      record.define('goal.create', {
        resume: (r) => {
          this.restoreCreate(r);
        },
      }),
    );
    this._register(
      record.define('goal.update', {
        resume: (r) => {
          this.restoreUpdate(r);
        },
      }),
    );
    this._register(
      record.define('goal.clear', {
        resume: () => {
          this.restoreClear();
        },
      }),
    );
    this._register(
      record.hooks.onResumeEnded.register('goal-normalize-after-replay', async (_ctx, next) => {
        await next();
        this.normalizeAfterReplay();
      }),
    );
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
      loopService.hooks.onStepUsage.register('goal-record-step-usage', async (ctx, next) => {
        this.handleStepUsage(ctx);
        await next();
      }),
    );
    this._register(
      loopService.hooks.afterStep.register('goal-outcome-continuation', async (ctx, next) => {
        await next();
        this.handleAfterStep(ctx);
      }),
    );
    this._register(
      turnService.hooks.onEnded.register('goal-drive-continuation', async (ctx, next) => {
        await next();
        await this.handleTurnEnded(ctx);
      }),
    );
    this._register(
      this.record.on((event) => {
        if (event.type === 'hook.result' && event.blocked === true) {
          this.promptHookBlockedTurns.add(event.turnId);
        }
      }),
    );

    this._register(toolRegistry.register(new CreateGoalTool(this, this.permissionMode)));
    this._register(toolRegistry.register(new GetGoalTool(this)));
    this._register(toolRegistry.register(new SetGoalBudgetTool(this)));
    this._register(toolRegistry.register(new UpdateGoalTool(this)));
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
    this.record.append({
      type: 'goal.create',
      goalId: state.goalId,
      objective: state.objective,
      completionCriterion: state.completionCriterion,
    });
    this.telemetry.track('goal_created', { actor, replace: input.replace === true });
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
    this.telemetry.track('goal_budget_set', {
      actor,
      ...budgetTelemetryProperties(input.budgetLimits),
    });
    return this.blockIfBudgetReached(state) ?? this.toSnapshot(state);
  }

  async cancelGoal(
    _input: GoalReasonInput = {},
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
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
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    this.applyStatus(state, 'blocked');
    state.terminalReason = input.reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason: input.reason, actor },
    });
    this.appendStatusUpdate(state, actor, input.reason);
    const snapshot = this.toSnapshot(state);
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
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.tokensUsed += Math.max(0, tokenDelta);
    this.persistState(state, { silent: true });
    this.appendGoalUpdate({ tokensUsed: state.tokensUsed });
    return this.blockIfBudgetReached(state) ?? this.toSnapshot(state);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    const state = this.state;
    if (state === undefined || state.status !== 'active') return null;
    state.turnsUsed += 1;
    this.persistState(state);
    this.appendGoalUpdate({ turnsUsed: state.turnsUsed });
    this.telemetry.track('goal_continued', { turns_used: state.turnsUsed });
    return this.blockIfBudgetReached(state) ?? this.toSnapshot(state);
  }

  private handleTurnLaunched(turn: Turn): void {
    const turnId = turn.id;
    if (this.state?.status === 'active') this.goalDrivenTurns.add(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);
    this.promptHookBlockedTurns.delete(turnId);
  }

  private async handleBeforeStep(ctx: TurnBeforeStepContext): Promise<void> {
    if (!this.goalDrivenTurns.has(ctx.turnId)) return;
    if (this.countedGoalTurns.has(ctx.turnId)) return;
    this.countedGoalTurns.add(ctx.turnId);
    await this.incrementTurn();
  }

  private handleStepUsage(ctx: TurnStepUsageContext): void {
    if (!this.goalDrivenTurns.has(ctx.turnId)) return;
    const snapshot = this.accountTokenUsage(tokenUsageTotal(ctx.usage));
    if (snapshot?.budget.overBudget === true) {
      ctx.stopTurn = true;
    }
  }

  private handleAfterStep(ctx: TurnAfterStepContext): void {
    if (this.goalOutcomeContinuationTurns.has(ctx.turnId)) return;
    if (!isGoalOutcomeReminder(this.context.get().at(-1))) return;
    this.goalOutcomeContinuationTurns.add(ctx.turnId);
    ctx.continueTurn = true;
  }

  private async handleTurnEnded(ctx: TurnEndedContext): Promise<void> {
    const turnId = ctx.turn.id;
    this.goalDrivenTurns.delete(turnId);
    this.countedGoalTurns.delete(turnId);
    this.goalOutcomeContinuationTurns.delete(turnId);

    const blockedByPromptHook = this.promptHookBlockedTurns.delete(turnId);
    if (blockedByPromptHook) {
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
    if (ctx.result.reason === 'filtered') {
      await this.pauseActiveGoal({ reason: GOAL_PROVIDER_FILTERED_PAUSE_REASON });
      return;
    }

    if (this.state?.status !== 'active') return;
    if (this.blockIfBudgetReached(this.state) !== null) return;
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
    this.turnService.launch(GOAL_CONTINUATION_ORIGIN, message.id);
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

  private restoreCreate(record: AgentRecord<'goal.create'>): void {
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

  private restoreUpdate(record: AgentRecord<'goal.update'>): void {
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

  private restoreForked(_record: AgentRecord<'forked'>): void {
    const hadGoal = this.state !== undefined;
    this.state = undefined;
    if (!hadGoal) return;
    this.reminders.appendSystemReminder(GOAL_FORK_CLEARED_REMINDER, {
      kind: 'system_trigger',
      name: 'goal_fork_cleared',
    });
  }

  private clearInternal(
    actor: GoalActor,
    opts: { readonly emit?: boolean; readonly track?: boolean } = {},
  ): void {
    if (this.state === undefined) return;
    this.persistState(undefined, { silent: opts.emit === false });
    this.record.append({ type: 'goal.clear' });
    if (opts.track !== false) this.telemetry.track('goal_cleared', { actor });
  }

  private appendStatusUpdate(state: GoalState, actor: GoalActor, reason?: string): void {
    this.appendGoalUpdate({
      status: state.status,
      reason,
      wallClockMs: liveWallClockMs(state),
      actor,
    });
    this.telemetry.track('goal_status_changed', {
      actor,
      status: state.status,
      turns_used: state.turnsUsed,
      tokens_used: state.tokensUsed,
      wall_clock_ms: liveWallClockMs(state),
      ...budgetTelemetryProperties(state.budgetLimits),
    });
  }

  private appendGoalUpdate(
    update: Omit<AgentRecord<'goal.update'>, 'type' | 'time'>,
  ): void {
    this.record.append({
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
    this.record.signal({ type: 'goal.updated', snapshot, change });
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

  private blockIfBudgetReached(state: GoalState): GoalSnapshot | null {
    if (state.status !== 'active') return null;
    const reason = goalBudgetBlockReason(this.toSnapshot(state).budget);
    if (reason === undefined) return null;
    this.applyStatus(state, 'blocked');
    state.terminalReason = reason;
    this.persistState(state, {
      change: { kind: 'lifecycle', status: 'blocked', reason, actor: 'runtime' },
    });
    this.appendStatusUpdate(state, 'runtime', reason);
    return this.toSnapshot(state);
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
