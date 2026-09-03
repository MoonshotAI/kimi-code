import { randomUUID } from 'node:crypto';

import { assign, fromCallback, sendTo, setup, type Snapshot } from 'xstate';

import { createDecorator, IInstantiationService } from '#/_base/di/instantiation';
import { MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { abortError } from '#/_base/utils/abort';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import {
  AgentActorService,
  type AgentActorContext,
  type AgentActorRestoreEvent,
} from '#/agent/actorService/agentActorService';
import { ContextAppendMessage } from '#/agent/contextMemory/contextEvents';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { GoalInjection, GOAL_WAIT_FOR_GUIDANCE } from '#/features/goal/injection/goalInjection';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { LoopErrors } from '#/agent/loop/errors';
import {
  IAgentLoopService,
  type AfterStepContext,
  type BeforeStepContext,
  type EnqueueReceipt,
} from '#/agent/loop/loop';
import { ContinuationStepRequest, MessageStepRequest } from '#/agent/loop/stepRequest';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { WAIT_FOR_FLAG_ID } from '#/agent/tools/task/task-wait/flag';
import { type UsageRecordedContext } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { registerEvent2Class } from '#/app/event/event2';
import { IFlagService } from '#/app/flag/flag';
import type { GoalBudgetProperties } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import {
  ErrorCodes,
  Error2,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from '#/errors';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionUsageService } from '#/session/usage/sessionUsage';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { ExecutableToolResult } from '#/tool/toolContract';

import type { GoalReasonInput, ResumeGoalInput } from './goal';
import { IGoalDeadlineScheduler } from './goalDeadlineScheduler';
import {
  GoalClear,
  GoalCreate,
  GoalForked,
  GoalUpdate,
  GoalUpdated,
  type GoalModelState,
  type GoalState,
} from './goalOps';
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

registerEvent2Class(GoalCreate);
registerEvent2Class(GoalUpdate);
registerEvent2Class(GoalClear);
registerEvent2Class(GoalForked);

const MAX_GOAL_OBJECTIVE_LENGTH = 4000;

const MAX_GOAL_COMPLETION_CRITERION_LENGTH = MAX_GOAL_OBJECTIVE_LENGTH;

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

const GOAL_FORK_CLEARED_REMINDER_NAME = 'goal_fork_cleared';

const GOAL_CONTINUATION_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'goal_continuation',
};
const GOAL_RATE_LIMIT_PAUSE_REASON = 'Paused after provider rate limit';
const GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX = 'Paused after provider connection error';
const GOAL_PROVIDER_AUTH_PAUSE_PREFIX = 'Paused after provider authentication error';
const GOAL_PROVIDER_API_PAUSE_PREFIX = 'Paused after provider API error';
const GOAL_MODEL_CONFIG_PAUSE_PREFIX = 'Paused after model configuration error';
const GOAL_RUNTIME_PAUSE_PREFIX = 'Paused after runtime error';
const GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX = 'Paused after goal continuation failure';
const GOAL_PROVIDER_FILTERED_PAUSE_REASON = 'Paused after provider safety policy block';
const GOAL_BUDGET_BLOCK_PREFIX = 'Blocked after goal budget reached';
const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

const GOAL_BUDGET_STOP_REMINDER_NAME = 'goal_budget_stop';

const GOAL_BUDGET_STOP_REMINDER = [
  "The goal's hard budget was reached and the goal is now blocked; the user can resume it with /goal resume.",
  'Stop immediately.',
  'Do not call any more tools: they will be rejected.',
  'Write a brief final status message summarizing the progress so far.',
].join(' ');

const GOAL_BUDGET_TOOLS_REJECTED_MESSAGE =
  'Goal budget exhausted; tool calls are rejected. Write your final message.';
const GOAL_STALE_TOOL_RESULT =
  'Goal changed since this turn started; ignored stale goal tool call.';

const GOAL_CONTINUATION_PROMPT = [
  'Continue working toward the active goal.',
  'Keep the self-audit brief. Do not explore unrelated interpretations once the goal can be',
  'decided. If the objective is simple, already answered, impossible, unsafe, or contradictory,',
  'do not run another goal turn. Explain briefly if useful, then call UpdateGoal with `complete`',
  'or `blocked` in the same turn. Otherwise, weigh the objective and any completion criteria',
  'against the work done so far, choose one bounded, useful slice of work, and use the existing',
  'conversation context and your tools. Do not try to finish a broad goal in one turn unless the',
  'whole goal is genuinely small. Most goal turns should not call UpdateGoal: after completing a',
  'useful slice, if material work remains, end the turn normally without calling UpdateGoal so',
  'the runtime can continue the goal in the next turn. Call UpdateGoal with `complete` only when',
  'all required work is done, any stated validation has passed, and there is no useful next',
  'action. Completion audit: before calling `complete`, verify the current state against the',
  'actual objective and every explicit requirement. Treat weak or indirect evidence as not',
  'complete. Do not mark complete after only producing a plan, summary, first pass, or partial',
  'result. Do not mark complete merely because a budget is nearly exhausted or you want to stop.',
  'Blocked audit: do not call UpdateGoal with `blocked` the first time you hit a blocker. Use',
  '`blocked` only for a genuine impasse: an external condition, required user input, missing',
  'credentials or permissions, or a persistent technical failure. For those non-terminal',
  'blockers, the same blocking condition must repeat for at least 3 consecutive goal turns before',
  'you call `blocked`, counting the original/user-triggered turn and automatic continuations.',
  'If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit.',
  'Exception: if the objective itself is impossible, unsafe, or contradictory, call UpdateGoal',
  'with `blocked` in the same turn; do not run more goal turns just to satisfy the audit. Do not',
  'use `blocked` because the work is large, hard, slow, uncertain, incomplete, still needs',
  'validation, would benefit from clarification, or needs more goal turns. Once the 3-turn',
  'threshold is met and you cannot make meaningful progress without user input or an',
  'external-state change, call UpdateGoal with `blocked`; do not keep reporting the blocker while',
  'leaving the goal active. Do not ask the user for input unless a real blocker prevents progress.',
].join(' ');

const GOAL_STEP_CAP_CONTINUATION_PROMPT = [
  'The previous goal turn reached the per-turn step limit before finishing its work,',
  'so a new turn was started for you. Pick up where that turn stopped and keep each',
  'slice of work small enough to fit the limit.',
  GOAL_CONTINUATION_PROMPT,
].join(' ');

export interface GoalForkNoticeState {
  readonly goalPresent: boolean;
  readonly reminderPending: boolean;
}

export interface GoalRuntimeState {
  readonly goal: GoalModelState;
  readonly forkNotice: GoalForkNoticeState;
}

interface PendingContinuation {
  readonly receipt: EnqueueReceipt;
  readonly goalId: string;
  turnId?: number;
}

interface ResumeContinuation {
  readonly turnId: number;
  readonly goalId: string;
}

interface GoalEffectState {
  pendingContinuation?: PendingContinuation;
  liveTurnId?: number;
  readonly goalDrivenTurns: Map<number, string>;
  readonly countedGoalTurns: Set<number>;
  readonly goalStarterTurns: Set<number>;
  readonly goalOutcomeToolResultTurns: Map<number, string>;
  readonly goalOutcomeContinuationTurns: Set<number>;
  readonly budgetGraceTurns: Set<number>;
  readonly pendingContinuationGoals: Map<number, string>;
  readonly goalTurnTargets: Map<number, string>;
  readonly exhaustedTurnBudgetGoals: Map<number, string>;
  liveWallClockStartedAt?: number;
  resumeContinuation?: ResumeContinuation;
}

interface GoalActorContext {
  readonly durable: GoalRuntimeState;
  readonly effects: GoalEffectState;
  readonly runtime: AgentActorContext<GoalRuntimeState>;
}

interface GoalCommitEvent {
  readonly type: 'goal.commit';
  readonly durable: GoalRuntimeState;
}

interface GoalDeadlineRefreshEvent {
  readonly type: 'goal.deadline.refresh';
}

interface GoalDeadlineClearEvent {
  readonly type: 'goal.deadline.clear';
}

type GoalEffectEvent = GoalDeadlineRefreshEvent | GoalDeadlineClearEvent;
type GoalActorEvent = GoalCommitEvent | AgentActorRestoreEvent | GoalEffectEvent;
type GoalActorSnapshot = Snapshot<unknown> & { readonly context: GoalActorContext; };

function isGoalForkClearedReminder(message: ContextMessage | undefined): boolean {
  const origin = message?.origin;
  if (origin?.kind === 'injection') return origin.variant === GOAL_FORK_CLEARED_REMINDER_NAME;
  return origin?.kind === 'system_trigger' && origin.name === GOAL_FORK_CLEARED_REMINDER_NAME;
}

function isGoalContinuationOrigin(origin: TurnStarted['origin']): boolean {
  return origin.kind === 'system_trigger' && origin.name === 'goal_continuation';
}

interface GoalOperationContext {
  readonly runtime: AgentActorContext<GoalRuntimeState>;
  readonly effects: GoalEffectState;
}

function goalOperationContext(runtime: AgentActorContext<GoalRuntimeState>): GoalOperationContext {
  return { runtime, effects: runtime.getLogicState<GoalActorContext>().effects };
}

function reminderOf(runtime: AgentActorContext<GoalRuntimeState>) {
  return runtime.get(IAgentReminderService);
}

function assertSupportedAgent(context: GoalOperationContext): void {
  if (context.runtime.agent.agentId === MAIN_AGENT_ID) return;
  throw new Error2(
    ErrorCodes.GOAL_UNSUPPORTED_AGENT,
    'Goals are only supported by the main agent',
    { details: { agentId: context.runtime.agent.agentId } },
  );
}

function getGoal(context: GoalOperationContext): GoalToolResult {
  assertSupportedAgent(context);
  const state = context.runtime.getState().goal;
  return { goal: state === null ? null : toSnapshot(context, state) };
}

function isGoalToolTarget(context: GoalOperationContext, turnId: number, goalId: string): boolean {
  assertSupportedAgent(context);
  return context.effects.goalTurnTargets.get(turnId) === goalId;
}

async function createGoal(context: GoalOperationContext, input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
  assertSupportedAgent(context);
  const objective = validateObjective(context, input.objective);
  prepareForGoalCreation(context, input.replace === true);
  const wallClockResumedAt = Date.now();
  void context.runtime.dispatch(
    new GoalCreate({
      agentId: context.runtime.agent.agentId,
      goalId: randomUUID(),
      objective,
      completionCriterion: normalizeCompletionCriterion(input.completionCriterion),
      wallClockResumedAt,
    }),
  );
  context.effects.liveWallClockStartedAt = context.runtime.get(IGoalDeadlineScheduler).now();
  adoptStarterTurn(context, actor);
  const state = requireState(context);
  refreshWallClockDeadline(context, state);
  emitGoalUpdated(context, toSnapshot(context, state));
  context.runtime.get(ITelemetryService).track2('goal_created', { actor, replace: input.replace === true });
  return toSnapshot(context, state);
}

function validateObjective(context: GoalOperationContext, value: string): string {
  const objective = value.trim();
  if (objective.length === 0) {
    throw new Error2(ErrorCodes.GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
  }
  if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
    throw new Error2(
      ErrorCodes.GOAL_OBJECTIVE_TOO_LONG,
      `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters. Put long content in a file and reference the file path.`,
    );
  }
  return objective;
}

function prepareForGoalCreation(context: GoalOperationContext, replace: boolean): void {
  if (context.runtime.getState().goal === null) return;
  if (!replace) {
    throw new Error2(
      ErrorCodes.GOAL_ALREADY_EXISTS,
      'A goal already exists; use replace to start a new one',
    );
  }
  clearInternal(context, 'system');
}

async function pauseGoal(context: GoalOperationContext, input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
  assertSupportedAgent(context);
  const state = requireState(context);
  if (state.status === 'paused') return toSnapshot(context, state);
  if (state.status !== 'active') {
    throw new Error2(
      ErrorCodes.GOAL_STATUS_INVALID,
      `Cannot pause a goal in status "${state.status}"`,
    );
  }
  return applyLifecycle(context, state, 'paused', input.reason, actor);
}

async function pauseActiveGoal(context: GoalOperationContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'runtime',
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(context);
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active') return null;
  return applyLifecycle(context, state, 'paused', input.reason, actor);
}

async function resumeGoal(context: GoalOperationContext, input: ResumeGoalInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
  assertSupportedAgent(context);
  const state = requireState(context);
  if (state.status === 'active') return toSnapshot(context, state);
  if (state.status !== 'paused' && state.status !== 'blocked') {
    throw new Error2(
      ErrorCodes.GOAL_NOT_RESUMABLE,
      `Cannot resume a goal in status "${state.status}"`,
    );
  }
  const continuePaused =
    actor === 'user' && state.status === 'paused' && input.continueIfPaused === true;
  const shouldContinue =
    continuePaused ||
    (actor === 'user' && state.status === 'blocked' && input.continueIfBlocked === true);
  const snapshot = applyLifecycle(context, state, 'active', input.reason, actor);
  if (!shouldContinue) return snapshot;
  const budgetBlocked = blockIfBudgetReached(context, requireState(context));
  if (budgetBlocked !== null) return budgetBlocked;
  if (canLaunchContinuation(context)) {
    try {
      launchContinuationTurn(context, state.goalId);
    } catch (error) {
      await settleGoalAfterContinuationFailure(context, error, state.goalId);
      throw error;
    }
  } else if (continuePaused && context.effects.liveTurnId !== undefined) {
    context.effects.resumeContinuation = { turnId: context.effects.liveTurnId, goalId: state.goalId };
  }
  return snapshot;
}

async function setBudgetLimits(context: GoalOperationContext,
  input: { readonly budgetLimits: GoalBudgetLimits; },
  actor: GoalActor = 'user',
): Promise<GoalSnapshot> {
  assertSupportedAgent(context);
  const state = requireState(context);
  const budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
  void context.runtime.dispatch(new GoalUpdate({ agentId: context.runtime.agent.agentId, budgetLimits }));
  const next = requireState(context);
  emitGoalUpdated(context, toSnapshot(context, next));
  context.runtime.get(ITelemetryService).track2('goal_budget_set', {
    actor,
    ...budgetTelemetryProperties(input.budgetLimits),
  });
  const blocked = blockIfBudgetReached(context, next);
  if (blocked !== null) return blocked;
  refreshWallClockDeadline(context, next);
  return toSnapshot(context, next);
}

async function cancelGoal(context: GoalOperationContext, _input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
  assertSupportedAgent(context);
  const state = requireState(context);
  const snapshot = toSnapshot(context, state);
  if (state.status === 'active' && context.effects.liveTurnId !== undefined) {
    context.runtime.get(IAgentLoopService).cancel(context.effects.liveTurnId, abortError('Goal cancelled'));
  }
  clearInternal(context, actor);
  if (actor === 'user') {
    reminderOf(context.runtime).notify(GOAL_CANCELLED_REMINDER, {
      variant: 'goal_cancelled',
    });
  }
  return snapshot;
}

async function markBlocked(context: GoalOperationContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'runtime',
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(context);
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active') return null;
  const snapshot = applyLifecycle(context, state, 'blocked', input.reason, actor, {
    preserveLiveContinuation: true,
  });
  return snapshot;
}

async function markComplete(context: GoalOperationContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'model',
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(context);
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active') return null;
  dispatchCompletion(context, state, input.reason, actor);
  const completed = requireState(context);
  const snapshot = toSnapshot(context, completed);
  emitCompletion(context, completed, snapshot, input.reason, actor);
  trackStatusChanged(context, completed, actor);
  clearInternal(context, actor, { preserveLiveContinuation: true });
  return snapshot;
}

function dispatchCompletion(context: GoalOperationContext, state: GoalState, reason: string | undefined, actor: GoalActor): void {
  const wallClockMs = settleWallClock(context, state);
  void context.runtime.dispatch(
    new GoalUpdate({ agentId: context.runtime.agent.agentId, status: 'complete', reason, wallClockMs, actor }),
  );
}

function emitCompletion(context: GoalOperationContext,
  state: GoalState,
  snapshot: GoalSnapshot,
  reason: string | undefined,
  actor: GoalActor,
): void {
  emitGoalUpdated(context, snapshot, {
    kind: 'completion',
    status: 'complete',
    reason,
    stats: statsOf(context, state),
    actor,
  });
}

async function pauseOnInterrupt(context: GoalOperationContext, input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
  assertSupportedAgent(context);
  return pauseActiveGoal(context, input, 'user');
}

async function recordTokenUsage(context: GoalOperationContext, tokenDelta: number): Promise<GoalSnapshot | null> {
  assertSupportedAgent(context);
  return accountTokenUsage(context, tokenDelta);
}

async function incrementTurn(context: GoalOperationContext): Promise<GoalSnapshot | null> {
  assertSupportedAgent(context);
  return incrementGoalTurn(context);
}

function accountTokenUsage(context: GoalOperationContext, tokenDelta: number, goalId?: string): GoalSnapshot | null {
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active' || !matchesGoal(state, goalId)) return null;
  const tokensUsed = state.tokensUsed + Math.max(0, tokenDelta);
  void context.runtime.dispatch(new GoalUpdate({ agentId: context.runtime.agent.agentId, tokensUsed }));
  const next = requireState(context);
  return blockIfBudgetReached(context, next) ?? toSnapshot(context, next);
}

function incrementGoalTurn(context: GoalOperationContext, goalId?: string): GoalSnapshot | null {
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active' || !matchesGoal(state, goalId)) return null;
  const turnsUsed = state.turnsUsed + 1;
  void context.runtime.dispatch(new GoalUpdate({ agentId: context.runtime.agent.agentId, turnsUsed }));
  const next = requireState(context);
  emitGoalUpdated(context, toSnapshot(context, next));
  context.runtime.get(ITelemetryService).track2('goal_continued', { turns_used: next.turnsUsed });
  return toSnapshot(context, next);
}

function handleTurnLaunched(context: GoalOperationContext, turnId: number, origin: TurnStarted['origin']): void {
  context.effects.liveTurnId = turnId;
  context.effects.goalTurnTargets.delete(turnId);
  context.effects.exhaustedTurnBudgetGoals.delete(turnId);
  if (!context.effects.goalDrivenTurns.has(turnId)) {
    const state = context.runtime.getState().goal;
    const continuationGoalId = isGoalContinuationOrigin(origin)
      ? context.effects.pendingContinuationGoals.get(turnId)
      : undefined;
    if (continuationGoalId !== undefined && state?.goalId !== continuationGoalId) {
      context.effects.goalDrivenTurns.set(turnId, continuationGoalId);
    } else if (state?.status === 'active' && blockIfBudgetReached(context, state) === null) {
      context.effects.goalDrivenTurns.set(turnId, state.goalId);
    }
  }
  context.effects.pendingContinuationGoals.delete(turnId);
  context.effects.goalOutcomeToolResultTurns.delete(turnId);
  context.effects.goalOutcomeContinuationTurns.delete(turnId);
}

function adoptStarterTurn(context: GoalOperationContext, actor: GoalActor): void {
  const turnId = context.effects.liveTurnId;
  if (turnId === undefined) return;
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active') return;
  const goalId = context.effects.goalDrivenTurns.get(turnId);
  if (actor === 'model') context.effects.goalTurnTargets.set(turnId, state.goalId);
  if (toSnapshot(context, state).budget.turnBudgetReached) {
    context.effects.exhaustedTurnBudgetGoals.set(turnId, state.goalId);
  } else {
    context.effects.exhaustedTurnBudgetGoals.delete(turnId);
  }
  if (goalId !== undefined) return;
  context.effects.goalDrivenTurns.set(turnId, state.goalId);
  context.effects.countedGoalTurns.add(turnId);
  context.effects.goalStarterTurns.add(turnId);
}

async function handleBeforeStep(context: GoalOperationContext, ctx: BeforeStepContext): Promise<void> {
  const goalId = context.effects.goalDrivenTurns.get(ctx.turnId);
  if (goalId === undefined) return;
  if (context.effects.countedGoalTurns.has(ctx.turnId)) return;
  context.effects.countedGoalTurns.add(ctx.turnId);
  incrementGoalTurn(context, goalId);
}

function handleUsageRecorded(context: GoalOperationContext, ctx: UsageRecordedContext): void {
  const source = ctx.source;
  if (source?.type !== 'turn') return;
  const goalId = context.effects.goalDrivenTurns.get(source.turnId);
  if (goalId === undefined) return;
  accountTokenUsage(context, ctx.usage.output, goalId);
}

function handleAfterStep(context: GoalOperationContext, ctx: AfterStepContext): void {
  if (stopAfterBudgetReached(context, ctx)) return;
  enqueueGoalOutcomeContinuation(context, ctx);
}

function stopAfterBudgetReached(context: GoalOperationContext, ctx: AfterStepContext): boolean {
  const goalId = goalTurnTarget(context, ctx.turnId);
  const state = context.runtime.getState().goal;
  const budget = state === null ? null : toSnapshot(context, state).budget;
  const turnBudgetBlocksCurrentTurn =
    budget?.turnBudgetReached === true &&
    (context.effects.exhaustedTurnBudgetGoals.get(ctx.turnId) === goalId ||
      (state?.status === 'blocked' &&
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
  const maxSteps = context.runtime.get(IConfigService).get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
  if (
    ctx.finishReason === 'tool_calls' &&
    !context.effects.budgetGraceTurns.has(ctx.turnId) &&
    hasStepBudgetRemaining(maxSteps, ctx.step)
  ) {
    context.effects.budgetGraceTurns.add(ctx.turnId);
    reminderOf(context.runtime).notify(GOAL_BUDGET_STOP_REMINDER, {
      variant: GOAL_BUDGET_STOP_REMINDER_NAME,
    });
    return true;
  }
  ctx.stopTurn = true;
  return true;
}

function enqueueGoalOutcomeContinuation(context: GoalOperationContext, ctx: AfterStepContext): void {
  if (context.effects.goalOutcomeContinuationTurns.has(ctx.turnId)) return;
  const goalId = goalTurnTarget(context, ctx.turnId);
  const outcomeGoalId = context.effects.goalOutcomeToolResultTurns.get(ctx.turnId);
  context.effects.goalOutcomeToolResultTurns.delete(ctx.turnId);
  if (goalId === undefined || outcomeGoalId !== goalId) return;
  const state = context.runtime.getState().goal;
  if (state !== null && state.goalId !== goalId) return;
  context.effects.goalOutcomeContinuationTurns.add(ctx.turnId);
  const maxSteps = context.runtime.get(IConfigService).get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
  if (!hasStepBudgetRemaining(maxSteps, ctx.step)) return;
  context.runtime.get(IAgentLoopService).enqueue(new ContinuationStepRequest());
}

async function handleTurnEnded(context: GoalOperationContext,
  turnId: number,
  result: Pick<TurnEnded, 'reason' | 'error'>,
): Promise<void> {
  const { goalId, lifecycleGoalId, starterTurn } = clearTurnTracking(context, turnId);
  const resumeContinuation = context.effects.resumeContinuation;
  if (resumeContinuation?.turnId === turnId) context.effects.resumeContinuation = undefined;
  if (resumeContinuation?.turnId === turnId && result.reason === 'cancelled') {
    const state = context.runtime.getState().goal;
    if (state === null || state.status !== 'active' || state.goalId !== resumeContinuation.goalId) {
      return;
    }
    if (blockIfBudgetReached(context, state) !== null) return;
    launchContinuationTurn(context, resumeContinuation.goalId);
    return;
  }
  if (goalId === undefined || lifecycleGoalId === undefined) return;
  const stepCapped = isMaxStepsTurnFailure(result);
  if (
    !stepCapped &&
    (result.reason === 'blocked' ||
      result.reason === 'cancelled' ||
      result.reason === 'failed')
  ) {
    await settleAbnormalTurn(context, result, lifecycleGoalId);
    return;
  }
  if (starterTurn) incrementGoalTurn(context, goalId);

  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active' || state.goalId !== lifecycleGoalId) return;
  if (blockIfBudgetReached(context, state) !== null) return;
  launchContinuationTurn(context, lifecycleGoalId, stepCapped);
}

function clearTurnTracking(
  context: GoalOperationContext,
  turnId: number,
): {
  readonly goalId?: string;
  readonly lifecycleGoalId?: string;
  readonly starterTurn: boolean;
} {
  if (context.effects.pendingContinuation?.turnId === turnId) {
    context.effects.pendingContinuation = undefined;
  }
  if (context.effects.liveTurnId === turnId) context.effects.liveTurnId = undefined;
  const goalId = context.effects.goalDrivenTurns.get(turnId);
  const lifecycleGoalId = goalTurnTarget(context, turnId);
  const starterTurn = context.effects.goalStarterTurns.delete(turnId);
  context.effects.goalDrivenTurns.delete(turnId);
  context.effects.countedGoalTurns.delete(turnId);
  context.effects.goalOutcomeToolResultTurns.delete(turnId);
  context.effects.goalOutcomeContinuationTurns.delete(turnId);
  context.effects.budgetGraceTurns.delete(turnId);
  context.effects.pendingContinuationGoals.delete(turnId);
  context.effects.goalTurnTargets.delete(turnId);
  context.effects.exhaustedTurnBudgetGoals.delete(turnId);
  return { goalId, lifecycleGoalId, starterTurn };
}

async function settleAbnormalTurn(context: GoalOperationContext,
  result: Pick<TurnEnded, 'reason' | 'error'>,
  goalId: string,
): Promise<boolean> {
  if (!isActiveGoal(context, goalId)) return false;
  if (result.reason === 'blocked') {
    await markBlocked(context, { reason: 'Blocked by UserPromptSubmit hook' });
    return true;
  }
  if (result.reason === 'cancelled') {
    await pauseOnInterrupt(context, { reason: 'Paused after interruption' });
    return true;
  }
  if (result.reason === 'failed') {
    await pauseActiveGoal(context, { reason: goalFailurePauseReason(result.error) });
    return true;
  }
  return false;
}

async function settleGoalAfterContinuationFailure(context: GoalOperationContext,
  error: unknown,
  goalId: string | undefined,
): Promise<void> {
  if (goalId === undefined || !isActiveGoal(context, goalId)) return;
  try {
    const reason = pauseReasonWithMessage(
      GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX,
      normalizeGoalErrorPayload(error).message,
    );
    await pauseActiveGoal(context, { reason }, 'system');
  } catch { }
}

function isWaitForAvailable(context: GoalOperationContext): boolean {
  return (
    context.runtime.get(IFlagService).enabled(WAIT_FOR_FLAG_ID) &&
    context.runtime.get(IAgentToolRegistryService).resolve('WaitFor') !== undefined &&
    context.runtime.get(IAgentToolPolicyService).isToolActive('WaitFor')
  );
}

function launchContinuationTurn(context: GoalOperationContext, goalId: string, stepCapped = false): void {
  if (!isActiveGoal(context, goalId)) return;
  if (context.effects.pendingContinuation !== undefined) return;
  const prompt = stepCapped ? GOAL_STEP_CAP_CONTINUATION_PROMPT : GOAL_CONTINUATION_PROMPT;
  const message: ContextMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: isWaitForAvailable(context)
          ? `${prompt} ${GOAL_WAIT_FOR_GUIDANCE}`
          : prompt,
      },
    ],
    toolCalls: [],
    origin: GOAL_CONTINUATION_ORIGIN,
  };
  const request = new MessageStepRequest(message, {
    kind: 'goal_continuation',
    admission: 'newTurn',
  });
  const receipt = context.runtime.get(IAgentLoopService).enqueue(request);
  const pending: PendingContinuation = { receipt, goalId };
  context.effects.pendingContinuation = pending;
  void receipt.assigned
    .then(({ turn }) => {
      pending.turnId = turn.id;
      if (!context.effects.goalDrivenTurns.has(turn.id)) {
        context.effects.pendingContinuationGoals.set(turn.id, pending.goalId);
      }
      return turn.result;
    })
    .finally(() => {
      if (pending.turnId !== undefined) context.effects.pendingContinuationGoals.delete(pending.turnId);
      if (context.effects.pendingContinuation === pending) context.effects.pendingContinuation = undefined;
    });
}

function canLaunchContinuation(context: GoalOperationContext): boolean {
  if (context.effects.liveTurnId !== undefined || context.effects.pendingContinuation !== undefined) return false;
  const status = context.runtime.get(IAgentLoopService).status();
  return status.state === 'idle' && !status.hasPendingRequests;
}

function isActiveGoal(context: GoalOperationContext, goalId: string): boolean {
  const state = context.runtime.getState().goal;
  return state?.status === 'active' && state.goalId === goalId;
}

function isStaleGoalToolCall(context: GoalOperationContext, ctx: BeforeToolExecuteEvent): boolean {
  const toolName = ctx.toolCall.name;
  if (!isGoalMutationTool(toolName)) return false;
  const goalId = goalTurnTarget(context, ctx.turnId);
  if (goalId === undefined) return false;
  return context.runtime.getState().goal?.goalId !== goalId;
}

function goalTurnTarget(context: GoalOperationContext, turnId: number): string | undefined {
  return context.effects.goalTurnTargets.get(turnId) ?? context.effects.goalDrivenTurns.get(turnId);
}

function cancelPendingContinuation(context: GoalOperationContext,
  preserveLiveContinuation = false,
  reason?: unknown,
): void {
  const pending = context.effects.pendingContinuation;
  if (preserveLiveContinuation && pending?.turnId === context.effects.liveTurnId) return;
  context.effects.pendingContinuation = undefined;
  const cancellation = reason ?? abortError('Goal continuation cancelled');
  const aborted = pending?.receipt.abort(cancellation);
  if (pending !== undefined && !aborted && pending.turnId !== undefined) {
    context.runtime.get(IAgentLoopService).cancel(pending.turnId, cancellation);
  }
}

function normalizeAfterReplay(context: GoalOperationContext): void {
  appendForkClearedReminder(context);
  context.runtime.send({ type: 'goal.deadline.clear' });
  context.effects.liveWallClockStartedAt = undefined;
  const state = context.runtime.getState().goal;
  if (state === null) return;
  if (state.status === 'complete') {
    clearInternal(context, 'runtime', { emit: false, track: false });
    return;
  }
  if (state.status !== 'active') return;

  const reason = 'Paused after agent resume';
  void context.runtime.dispatch(
    new GoalUpdate({
      agentId: context.runtime.agent.agentId,
      status: 'paused',
      reason,
      wallClockMs: settleWallClock(context, state),
      actor: 'runtime',
    }),
  );
  trackStatusChanged(context, requireState(context), 'runtime');
}

function appendForkClearedReminder(context: GoalOperationContext): void {
  if (!context.runtime.getState().forkNotice.reminderPending) return;
  reminderOf(context.runtime).notify(GOAL_FORK_CLEARED_REMINDER, {
    variant: GOAL_FORK_CLEARED_REMINDER_NAME,
  });
}

function clearInternal(context: GoalOperationContext,
  actor: GoalActor,
  opts: { readonly emit?: boolean; readonly track?: boolean; readonly preserveLiveContinuation?: boolean; } = {},
): void {
  if (context.runtime.getState().goal === null) return;
  context.effects.resumeContinuation = undefined;
  cancelPendingContinuation(context, opts.preserveLiveContinuation === true);
  context.runtime.send({ type: 'goal.deadline.clear' });
  context.effects.liveWallClockStartedAt = undefined;
  void context.runtime.dispatch(new GoalClear({ agentId: context.runtime.agent.agentId }));
  if (opts.emit !== false) emitGoalUpdated(context, null);
  if (opts.track !== false) context.runtime.get(ITelemetryService).track2('goal_cleared', { actor });
}

function applyLifecycle(context: GoalOperationContext,
  state: GoalState,
  status: GoalStatus,
  reason: string | undefined,
  actor: GoalActor,
  opts: {
    readonly preserveLiveContinuation?: boolean;
    readonly cancellationReason?: unknown;
  } = {},
): GoalSnapshot {
  const wallClockMs = settleWallClock(context, state);
  const wallClockResumedAt = status === 'active' ? Date.now() : undefined;
  if (status === 'active') {
    context.effects.liveWallClockStartedAt = context.runtime.get(IGoalDeadlineScheduler).now();
  } else if (state.status === 'active') {
    context.effects.resumeContinuation = undefined;
    cancelPendingContinuation(context,
      opts.preserveLiveContinuation === true,
      opts.cancellationReason,
    );
    context.runtime.send({ type: 'goal.deadline.clear' });
    context.effects.liveWallClockStartedAt = undefined;
  }
  void context.runtime.dispatch(
    new GoalUpdate({ agentId: context.runtime.agent.agentId, status, reason, wallClockMs, wallClockResumedAt, actor }),
  );
  const next = requireState(context);
  if (status === 'active') adoptStarterTurn(context, actor);
  if (status === 'active') refreshWallClockDeadline(context, next);
  emitGoalUpdated(context, toSnapshot(context, next), { kind: 'lifecycle', status, reason, actor });
  trackStatusChanged(context, next, actor);
  return toSnapshot(context, next);
}

function trackStatusChanged(context: GoalOperationContext, state: GoalState, actor: GoalActor): void {
  context.runtime.get(ITelemetryService).track2('goal_status_changed', {
    actor,
    status: state.status,
    turns_used: state.turnsUsed,
    tokens_used: state.tokensUsed,
    wall_clock_ms: liveWallClockMs(context, state),
    ...budgetTelemetryProperties(state.budgetLimits),
  });
}

function requireState(context: GoalOperationContext): GoalState {
  const state = context.runtime.getState().goal;
  if (state === null) {
    throw new Error2(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
  }
  return state;
}

function emitGoalUpdated(context: GoalOperationContext, snapshot: GoalSnapshot | null, change?: GoalChange): void {
  void context.runtime.dispatch(
    new GoalUpdated({ agentId: context.runtime.agent.agentId, snapshot, change }),
  );
}

function settleWallClock(context: GoalOperationContext, state: GoalState): number {
  if (state.status === 'active' && context.effects.liveWallClockStartedAt !== undefined) {
    return (
      state.wallClockMs +
      Math.max(0, context.runtime.get(IGoalDeadlineScheduler).now() - context.effects.liveWallClockStartedAt)
    );
  }
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function liveWallClockMs(context: GoalOperationContext, state: GoalState): number {
  if (state.status === 'active' && context.effects.liveWallClockStartedAt !== undefined) {
    return (
      state.wallClockMs +
      Math.max(0, context.runtime.get(IGoalDeadlineScheduler).now() - context.effects.liveWallClockStartedAt)
    );
  }
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function statsOf(context: GoalOperationContext, state: GoalState): GoalChangeStats {
  return {
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs: liveWallClockMs(context, state),
  };
}

function toSnapshot(context: GoalOperationContext, state: GoalState): GoalSnapshot {
  const wallClockMs = liveWallClockMs(context, state);
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

function blockIfBudgetReached(context: GoalOperationContext, state: GoalState): GoalSnapshot | null {
  if (state.status !== 'active') return null;
  const reason = goalBudgetBlockReason(toSnapshot(context, state).budget);
  if (reason === undefined) return null;
  return applyLifecycle(context, state, 'blocked', reason, 'runtime', {
    preserveLiveContinuation: true,
  });
}

function refreshWallClockDeadline(context: GoalOperationContext, _state: GoalState): void {
  context.runtime.send({ type: 'goal.deadline.refresh' });
}

function wallClockDeadlineDelay(context: GoalOperationContext): number | undefined {
  const state = context.runtime.getState().goal;
  const budgetMs = state?.budgetLimits.wallClockBudgetMs;
  if (
    state === null ||
    state.status !== 'active' ||
    budgetMs === undefined ||
    context.effects.liveWallClockStartedAt === undefined
  ) return undefined;
  return Math.max(0, budgetMs - liveWallClockMs(context, state));
}

function handleWallClockDeadline(context: GoalOperationContext): void {
  context.runtime.send({ type: 'goal.deadline.clear' });
  const state = context.runtime.getState().goal;
  if (state === null || state.status !== 'active') return;
  const budgetMs = state.budgetLimits.wallClockBudgetMs;
  if (budgetMs === undefined) return;
  if (liveWallClockMs(context, state) < budgetMs) {
    refreshWallClockDeadline(context, state);
    return;
  }
  const reason = goalBudgetBlockReason(toSnapshot(context, state).budget);
  if (reason === undefined) return;
  const cancellation = abortError(reason);
  const liveTurnId = context.effects.liveTurnId;
  const pendingTurnId = context.effects.pendingContinuation?.turnId;
  applyLifecycle(context, state, 'blocked', reason, 'runtime', {
    cancellationReason: cancellation,
  });
  if (liveTurnId !== undefined && liveTurnId !== pendingTurnId) {
    context.runtime.get(IAgentLoopService).cancel(liveTurnId, cancellation);
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

function matchesGoal(state: GoalState, goalId: string | undefined): boolean {
  return goalId === undefined || state.goalId === goalId;
}

function isGoalMutationTool(toolName: string): boolean {
  return toolName === 'CreateGoal' || toolName === 'UpdateGoal' || toolName === 'SetGoalBudget';
}

function toGoalStartReviewPermissionMode(label: string | undefined): PermissionMode | undefined {
  if (label === 'auto' || label === 'yolo' || label === 'manual') return label;
  return undefined;
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

function isMaxStepsTurnFailure(result: Pick<TurnEnded, 'reason' | 'error'>): boolean {
  return (
    result.reason === 'failed' &&
    normalizeGoalErrorPayload(result.error).code === LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED
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

function createGoalEffectHandlers(runtime: AgentActorContext<GoalRuntimeState>) {
  const context = goalOperationContext(runtime);
  return {
    deadlineDelay: () => wallClockDeadlineDelay(context),
    deadlineFired: () => { handleWallClockDeadline(context); },
    injection: {
      getGoal: () => getGoal(context).goal,
      isWaitForEnabled: () => isWaitForAvailable(context),
    },
    normalize: () => { normalizeAfterReplay(context); },
    turnStarted: (event: TurnStarted) => { handleTurnLaunched(context, event.turnId, event.origin); },
    usageRecorded: (usage: UsageRecordedContext) => {
      if (usage.agent === runtime.agent) handleUsageRecorded(context, usage);
    },
    beforeStep: (step: BeforeStepContext) => handleBeforeStep(context, step),
    afterStep: (step: AfterStepContext) => { handleAfterStep(context, step); },
    approval: (event: BeforeToolExecuteEvent) => {
      const permissionMode = runtime.get(IAgentPermissionModeService);
      if (
        event.toolCall.name !== 'CreateGoal' ||
        permissionMode.mode === 'auto' ||
        event.execution.display?.kind !== 'goal_start'
      ) return;
      event.waitUntil(async () => runtime.get(IAgentToolApprovalService).requestToolApproval(
        event,
        {
          kind: 'ask',
          resolveApproval: (approval) => {
            if (approval.decision !== 'approved') return undefined;
            const mode = toGoalStartReviewPermissionMode(approval.selectedLabel);
            if (mode !== undefined && mode !== permissionMode.mode) permissionMode.setMode(mode);
            return undefined;
          },
        },
        'goal-start-review-ask',
      ));
    },
    veto: (event: BeforeToolExecuteEvent) => {
      if (isStaleGoalToolCall(context, event)) {
        event.veto({ output: GOAL_STALE_TOOL_RESULT });
        return;
      }
      if (context.effects.budgetGraceTurns.has(event.turnId)) {
        event.veto({ output: GOAL_BUDGET_TOOLS_REJECTED_MESSAGE });
      }
    },
    toolCompleted: (tool: Parameters<Parameters<IAgentToolExecutorService['hooks']['onDidExecuteTool']['register']>[1]>[0]) => {
      const goalId = goalTurnTarget(context, tool.turnId);
      if (
        goalId !== undefined &&
        isTerminalUpdateGoalResult(tool.toolCall.name, tool.args, tool.result)
      ) context.effects.goalOutcomeToolResultTurns.set(tool.turnId, goalId);
    },
    turnEnded: (event: TurnEnded) => {
      const goalId = goalTurnTarget(context, event.turnId);
      void handleTurnEnded(context, event.turnId, { reason: event.reason, error: event.error }).catch(
        (error) => settleGoalAfterContinuationFailure(context, error, goalId),
      );
    },
  };
}

const goalEffects = fromCallback(({
  input,
  receive,
}: {
  input: {
    readonly runtime: AgentActorContext<GoalRuntimeState>;
    readonly restore: AgentActorRestoreEvent;
  };
  receive: (listener: (event: GoalEffectEvent) => void) => void;
}) => {
  const handlers = createGoalEffectHandlers(input.runtime);
  const deadline = new MutableDisposable<IDisposable>();
  receive((event) => {
    deadline.clear();
    if (event.type === 'goal.deadline.refresh') {
      const delay = handlers.deadlineDelay();
      if (delay !== undefined) {
        deadline.value = input.runtime.get(IGoalDeadlineScheduler).schedule(delay, handlers.deadlineFired);
      }
    }
  });
  const disposables: IDisposable[] = [deadline];
  if (input.runtime.agent.agentId === MAIN_AGENT_ID) {
    disposables.push(new GoalInjection(handlers.injection, reminderOf(input.runtime)));
    disposables.push(input.runtime.get(IEventBus).subscribe(TurnStarted, handlers.turnStarted));
    disposables.push(input.runtime.get(ISessionUsageService).onDidRecord(handlers.usageRecorded));
    const loop = input.runtime.get(IAgentLoopService);
    disposables.push(loop.hooks.onWillBeginStep.register('goal-count-turn', async (context, next) => {
      await handlers.beforeStep(context);
      await next();
    }));
    disposables.push(loop.hooks.onDidFinishStep.register('goal-outcome-continuation', async (context, next) => {
      handlers.afterStep(context);
      await next();
    }));
    const tools = input.runtime.get(IAgentToolExecutorService);
    disposables.push(tools.onBeforeExecuteTool(handlers.approval));
    disposables.push(tools.onBeforeExecuteTool(handlers.veto));
    disposables.push(tools.hooks.onDidExecuteTool.register(
      'goal-outcome-tool-result',
      async (context, next) => {
        handlers.toolCompleted(context);
        await next();
      },
    ));
    disposables.push(input.runtime.get(IEventBus).subscribe(TurnEnded, handlers.turnEnded));
    handlers.normalize();
  }
  input.restore.waitUntil(Promise.resolve());
  return () => {
    for (let index = disposables.length - 1; index >= 0; index -= 1) {
      disposables[index]!.dispose();
    }
  };
});

const goalActorLogic = setup({
  types: {} as {
    context: GoalActorContext;
    input: AgentActorContext<GoalRuntimeState>;
    events: GoalActorEvent;
  },
  actors: { goalEffects },
}).createMachine({
  context: ({ input }) => ({
    durable: {
      goal: null,
      forkNotice: { goalPresent: false, reminderPending: false },
    },
    effects: {
      goalDrivenTurns: new Map(),
      countedGoalTurns: new Set(),
      goalStarterTurns: new Set(),
      goalOutcomeToolResultTurns: new Map(),
      goalOutcomeContinuationTurns: new Set(),
      budgetGraceTurns: new Set(),
      pendingContinuationGoals: new Map(),
      goalTurnTargets: new Map(),
      exhaustedTurnBudgetGoals: new Map(),
    },
    runtime: input,
  }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {
      invoke: {
        id: 'goalEffects',
        src: 'goalEffects',
        input: ({ context, event }) => ({
          runtime: context.runtime,
          restore: event as AgentActorRestoreEvent,
        }),
      },
      on: {
        'goal.deadline.refresh': { actions: sendTo('goalEffects', ({ event }) => event) },
        'goal.deadline.clear': { actions: sendTo('goalEffects', ({ event }) => event) },
      },
    },
  },
  on: {
    'goal.commit': {
      actions: assign({ durable: ({ event }) => event.durable }),
    },
  },
});

export interface IAgentGoalService {
  readonly _serviceBrand: undefined;
  getGoal(): GoalToolResult;
  isGoalToolTarget(turnId: number, goalId: string): boolean;
  createGoal(input: CreateGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  pauseGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  resumeGoal(input?: ResumeGoalInput, actor?: GoalActor): Promise<GoalSnapshot>;
  setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor?: GoalActor,
  ): Promise<GoalSnapshot>;
  cancelGoal(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot>;
  markBlocked(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot | null>;
  markComplete(input?: GoalReasonInput, actor?: GoalActor): Promise<GoalSnapshot | null>;
  pauseOnInterrupt(input?: GoalReasonInput): Promise<GoalSnapshot | null>;
  recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null>;
  incrementTurn(): Promise<GoalSnapshot | null>;
}

export const IAgentGoalService = createDecorator<IAgentGoalService>('agentGoalService');

export class AgentGoalService extends AgentActorService<GoalRuntimeState> implements IAgentGoalService {
  declare readonly _serviceBrand: undefined;

  private readonly actor: AgentActorContext<GoalRuntimeState>;

  constructor(
    @IEventDispatcher dispatcher: IEventDispatcher,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super(dispatcher, scopeContext, instantiation);
    this.actor = this.attachActor(goalActorLogic, {
      id: 'goal',
      durable: {
        events: [GoalCreate, GoalUpdate, GoalClear, GoalForked, ContextAppendMessage],
        undoable: false,
        transition: (state, event) => {
          if (event instanceof GoalCreate) {
            state.goal = {
              goalId: event.goalId,
              objective: event.objective,
              completionCriterion: event.completionCriterion,
              status: 'active',
              turnsUsed: 0,
              tokensUsed: 0,
              wallClockMs: 0,
              wallClockResumedAt: event.wallClockResumedAt,
              budgetLimits: {},
            };
            state.forkNotice.goalPresent = true;
            return;
          }
          if (event instanceof GoalUpdate) {
            const s = state.goal;
            if (s !== null) {
              if (event.status !== undefined && event.status !== s.status) {
                s.status = event.status;
                s.terminalReason = event.status === 'active' ? undefined : event.reason;
                s.wallClockResumedAt = event.status === 'active' ? event.wallClockResumedAt : undefined;
              }
              if (event.turnsUsed !== undefined && event.turnsUsed !== s.turnsUsed) {
                s.turnsUsed = event.turnsUsed;
              }
              if (event.tokensUsed !== undefined && event.tokensUsed !== s.tokensUsed) {
                s.tokensUsed = event.tokensUsed;
              }
              if (event.wallClockMs !== undefined && event.wallClockMs !== s.wallClockMs) {
                s.wallClockMs = event.wallClockMs;
              }
              if (
                event.wallClockResumedAt !== undefined &&
                (event.status ?? s.status) === 'active' &&
                event.wallClockResumedAt !== s.wallClockResumedAt
              ) {
                s.wallClockResumedAt = event.wallClockResumedAt;
              }
              if (event.budgetLimits !== undefined && event.budgetLimits !== s.budgetLimits) {
                s.budgetLimits = event.budgetLimits;
              }
            }
            return;
          }
          if (event instanceof GoalClear) {
            state.goal = null;
            state.forkNotice.goalPresent = false;
            return;
          }
          if (event instanceof GoalForked) {
            state.goal = null;
            state.forkNotice.reminderPending =
              state.forkNotice.goalPresent || state.forkNotice.reminderPending;
            state.forkNotice.goalPresent = false;
            return;
          }
          if (event instanceof ContextAppendMessage) {
            if (state.forkNotice.reminderPending && isGoalForkClearedReminder(event.message)) {
              state.forkNotice.reminderPending = false;
            }
          }
        },
        read: (snapshot) => (snapshot as GoalActorSnapshot).context.durable,
        commit: (actor, durable) => { actor.send({ type: 'goal.commit', durable }); },
      },
    });
  }

  getGoal(): GoalToolResult {
    return getGoal(goalOperationContext(this.actor));
  }

  isGoalToolTarget(turnId: number, goalId: string): boolean {
    return isGoalToolTarget(goalOperationContext(this.actor), turnId, goalId);
  }

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return createGoal(goalOperationContext(this.actor), input, actor);
  }

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return pauseGoal(goalOperationContext(this.actor), input, actor);
  }

  async resumeGoal(input: ResumeGoalInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return resumeGoal(goalOperationContext(this.actor), input, actor);
  }

  async setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    return setBudgetLimits(goalOperationContext(this.actor), input, actor);
  }

  async cancelGoal(_input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return cancelGoal(goalOperationContext(this.actor), _input, actor);
  }

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    return markBlocked(goalOperationContext(this.actor), input, actor);
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    return markComplete(goalOperationContext(this.actor), input, actor);
  }

  async pauseOnInterrupt(input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
    return pauseOnInterrupt(goalOperationContext(this.actor), input);
  }

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    return recordTokenUsage(goalOperationContext(this.actor), tokenDelta);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    return incrementTurn(goalOperationContext(this.actor));
  }
}

