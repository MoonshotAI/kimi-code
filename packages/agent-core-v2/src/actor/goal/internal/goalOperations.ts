import { randomUUID } from 'node:crypto';

import { abortError } from '#/_base/utils/abort';
import { isPlainRecord } from '#/_base/utils/canonical-args';
import { AgentReminder, type ReminderRuntime } from '#/actor/reminder/reminderAgentRuntime';
import type { ContextMessage, PromptOrigin } from '#/actor/contextMemory/types';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/actor/loop/configSection';
import { LoopErrors } from '#/actor/loop/internal/errors';
import { getLoopControl } from '#/actor/loop/internal/access';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { AfterStepContext, BeforeStepContext } from '#/actor/loop/internal/loop';
import { ContinuationStepRequest, MessageStepRequest } from '#/actor/loop/internal/stepRequest';
import type { TurnStarted } from '#/actor/loop/turnEvents';
import type { TurnEnded } from '#/actor/loop/turnOps';
import { AgentPermissionMode } from '#/actor/permissionMode/permissionModeAgentRuntime';
import { toContractMode } from '#/actor/permissionMode/internal/modeMapping';
import type { PermissionMode } from '#/actor/toolExecutor/permissionTypes';
import { ISessionToolApprovalService } from '#/agent/toolApproval/sessionToolApprovalService';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import type { BeforeToolExecuteEvent, ToolDidExecuteContext } from '#/actor/toolExecutor/toolHooks';
import { WAIT_FOR_FLAG_ID } from '#/actor/task/tools/task-wait/flag';
import { type UsageRecordedContext } from '#/agent/usage/usage';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import type { GoalBudgetProperties } from '#/app/telemetry/events';
import {
  ErrorCodes,
  Error2,
  toKimiErrorPayload,
  type KimiErrorPayload,
} from '#/errors';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import type { ExecutableToolResult } from '#/tool/toolContract';

import type { GoalReasonInput, ResumeGoalInput } from '../goal';
import { GOAL_WAIT_FOR_GUIDANCE } from '../injection/goalInjection';
import { IGoalDeadlineScheduler } from '../goalDeadlineScheduler';
import { GoalClear, GoalCreate, GoalUpdate, GoalUpdated, type GoalState } from '../goalOps';
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
} from '../types';
import type {
  GoalMachineContext,
  GoalRuntimeContext,
  PendingContinuation,
} from './goalMachine';

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

export const GOAL_FORK_CLEARED_REMINDER_NAME = 'goal_fork_cleared';

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

export function machineContextOf(runtime: GoalRuntimeContext): GoalMachineContext {
  return runtime.getLogicState<GoalMachineContext>();
}

export function reminderOf(runtime: GoalRuntimeContext): ReminderRuntime {
  return runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentReminder);
}

function isGoalContinuationOrigin(origin: TurnStarted['origin']): boolean {
  return origin.kind === 'system_trigger' && origin.name === 'goal_continuation';
}

function assertSupportedAgent(runtime: GoalRuntimeContext): void {
  if (runtime.agent.agentId === MAIN_AGENT_ID) return;
  throw new Error2(
    ErrorCodes.GOAL_UNSUPPORTED_AGENT,
    'Goals are only supported by the main agent',
    { details: { agentId: runtime.agent.agentId } },
  );
}

export function getGoal(runtime: GoalRuntimeContext): GoalToolResult {
  assertSupportedAgent(runtime);
  const state = runtime.getState().goal;
  return { goal: state === null ? null : toSnapshot(runtime, state) };
}

export function isGoalToolTarget(
  runtime: GoalRuntimeContext,
  turnId: number,
  goalId: string,
): boolean {
  assertSupportedAgent(runtime);
  return machineContextOf(runtime).goalTurnTargets.get(turnId) === goalId;
}

export async function createGoal(
  runtime: GoalRuntimeContext,
  input: CreateGoalInput,
  actor: GoalActor = 'user',
): Promise<GoalSnapshot> {
  assertSupportedAgent(runtime);
  const objective = validateObjective(input.objective);
  prepareForGoalCreation(runtime, input.replace === true);
  const wallClockResumedAt = Date.now();
  void runtime.dispatch(
    new GoalCreate({
      agentId: runtime.agent.agentId,
      goalId: randomUUID(),
      objective,
      completionCriterion: normalizeCompletionCriterion(input.completionCriterion),
      wallClockResumedAt,
    }),
  );
  runtime.send({
    type: 'goal.wallClockStarted',
    at: runtime.get(IGoalDeadlineScheduler).now(),
  });
  adoptStarterTurn(runtime, actor);
  const state = requireState(runtime);
  refreshWallClockDeadline(runtime);
  emitGoalUpdated(runtime, toSnapshot(runtime, state));
  runtime
    .get(IAgentHostService)
    .of(runtime.agent)
    .telemetry.track2('goal_created', { actor, replace: input.replace === true });
  return toSnapshot(runtime, state);
}

function validateObjective(value: string): string {
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

function prepareForGoalCreation(runtime: GoalRuntimeContext, replace: boolean): void {
  if (runtime.getState().goal === null) return;
  if (!replace) {
    throw new Error2(
      ErrorCodes.GOAL_ALREADY_EXISTS,
      'A goal already exists; use replace to start a new one',
    );
  }
  clearInternal(runtime, 'system');
}

export async function pauseGoal(
  runtime: GoalRuntimeContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'user',
): Promise<GoalSnapshot> {
  assertSupportedAgent(runtime);
  const state = requireState(runtime);
  if (state.status === 'paused') return toSnapshot(runtime, state);
  if (state.status !== 'active') {
    throw new Error2(
      ErrorCodes.GOAL_STATUS_INVALID,
      `Cannot pause a goal in status "${state.status}"`,
    );
  }
  return applyLifecycle(runtime, state, 'paused', input.reason, actor);
}

async function pauseActiveGoal(
  runtime: GoalRuntimeContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'runtime',
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(runtime);
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active') return null;
  return applyLifecycle(runtime, state, 'paused', input.reason, actor);
}

export async function resumeGoal(
  runtime: GoalRuntimeContext,
  input: ResumeGoalInput = {},
  actor: GoalActor = 'user',
): Promise<GoalSnapshot> {
  assertSupportedAgent(runtime);
  const state = requireState(runtime);
  if (state.status === 'active') return toSnapshot(runtime, state);
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
  const snapshot = applyLifecycle(runtime, state, 'active', input.reason, actor);
  if (!shouldContinue) return snapshot;
  const budgetBlocked = blockIfBudgetReached(runtime, requireState(runtime));
  if (budgetBlocked !== null) return budgetBlocked;
  if (canLaunchContinuation(runtime)) {
    try {
      launchContinuationTurn(runtime, state.goalId);
    } catch (error) {
      await settleGoalAfterContinuationFailure(runtime, error, state.goalId);
      throw error;
    }
  } else {
    const liveTurnId = machineContextOf(runtime).liveTurnId;
    if (continuePaused && liveTurnId !== undefined) {
      runtime.send({ type: 'goal.resumeScheduled', turnId: liveTurnId, goalId: state.goalId });
    }
  }
  return snapshot;
}

export async function setBudgetLimits(
  runtime: GoalRuntimeContext,
  input: { readonly budgetLimits: GoalBudgetLimits },
  actor: GoalActor = 'user',
): Promise<GoalSnapshot> {
  assertSupportedAgent(runtime);
  const state = requireState(runtime);
  const budgetLimits = { ...state.budgetLimits, ...input.budgetLimits };
  void runtime.dispatch(new GoalUpdate({ agentId: runtime.agent.agentId, budgetLimits }));
  const next = requireState(runtime);
  emitGoalUpdated(runtime, toSnapshot(runtime, next));
  runtime.get(IAgentHostService).of(runtime.agent).telemetry.track2('goal_budget_set', {
    actor,
    ...budgetTelemetryProperties(input.budgetLimits),
  });
  const blocked = blockIfBudgetReached(runtime, next);
  if (blocked !== null) return blocked;
  refreshWallClockDeadline(runtime);
  return toSnapshot(runtime, next);
}

export async function cancelGoal(
  runtime: GoalRuntimeContext,
  _input: GoalReasonInput = {},
  actor: GoalActor = 'user',
): Promise<GoalSnapshot> {
  assertSupportedAgent(runtime);
  const state = requireState(runtime);
  const snapshot = toSnapshot(runtime, state);
  const liveTurnId = machineContextOf(runtime).liveTurnId;
  if (state.status === 'active' && liveTurnId !== undefined) {
    getLoopControl(runtime.agent).cancel(liveTurnId, abortError('Goal cancelled'));
  }
  clearInternal(runtime, actor);
  if (actor === 'user') {
    reminderOf(runtime).notify(GOAL_CANCELLED_REMINDER, {
      variant: 'goal_cancelled',
    });
  }
  return snapshot;
}

export async function markBlocked(
  runtime: GoalRuntimeContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'runtime',
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(runtime);
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active') return null;
  const snapshot = applyLifecycle(runtime, state, 'blocked', input.reason, actor, {
    preserveLiveContinuation: true,
  });
  return snapshot;
}

export async function markComplete(
  runtime: GoalRuntimeContext,
  input: GoalReasonInput = {},
  actor: GoalActor = 'model',
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(runtime);
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active') return null;
  dispatchCompletion(runtime, state, input.reason, actor);
  const completed = requireState(runtime);
  const snapshot = toSnapshot(runtime, completed);
  emitCompletion(runtime, completed, snapshot, input.reason, actor);
  trackStatusChanged(runtime, completed, actor);
  clearInternal(runtime, actor, { preserveLiveContinuation: true });
  return snapshot;
}

function dispatchCompletion(
  runtime: GoalRuntimeContext,
  state: GoalState,
  reason: string | undefined,
  actor: GoalActor,
): void {
  const wallClockMs = liveWallClockMs(runtime, state);
  void runtime.dispatch(
    new GoalUpdate({
      agentId: runtime.agent.agentId,
      status: 'complete',
      reason,
      wallClockMs,
      actor,
    }),
  );
}

function emitCompletion(
  runtime: GoalRuntimeContext,
  state: GoalState,
  snapshot: GoalSnapshot,
  reason: string | undefined,
  actor: GoalActor,
): void {
  emitGoalUpdated(runtime, snapshot, {
    kind: 'completion',
    status: 'complete',
    reason,
    stats: statsOf(runtime, state),
    actor,
  });
}

export async function pauseOnInterrupt(
  runtime: GoalRuntimeContext,
  input: GoalReasonInput = {},
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(runtime);
  return pauseActiveGoal(runtime, input, 'user');
}

export async function recordTokenUsage(
  runtime: GoalRuntimeContext,
  tokenDelta: number,
): Promise<GoalSnapshot | null> {
  assertSupportedAgent(runtime);
  return accountTokenUsage(runtime, tokenDelta);
}

export async function incrementTurn(runtime: GoalRuntimeContext): Promise<GoalSnapshot | null> {
  assertSupportedAgent(runtime);
  return incrementGoalTurn(runtime);
}

function accountTokenUsage(
  runtime: GoalRuntimeContext,
  tokenDelta: number,
  goalId?: string,
): GoalSnapshot | null {
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active' || !matchesGoal(state, goalId)) return null;
  const tokensUsed = state.tokensUsed + Math.max(0, tokenDelta);
  void runtime.dispatch(new GoalUpdate({ agentId: runtime.agent.agentId, tokensUsed }));
  const next = requireState(runtime);
  return blockIfBudgetReached(runtime, next) ?? toSnapshot(runtime, next);
}

function incrementGoalTurn(runtime: GoalRuntimeContext, goalId?: string): GoalSnapshot | null {
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active' || !matchesGoal(state, goalId)) return null;
  const turnsUsed = state.turnsUsed + 1;
  void runtime.dispatch(new GoalUpdate({ agentId: runtime.agent.agentId, turnsUsed }));
  const next = requireState(runtime);
  emitGoalUpdated(runtime, toSnapshot(runtime, next));
  runtime
    .get(IAgentHostService)
    .of(runtime.agent)
    .telemetry.track2('goal_continued', { turns_used: next.turnsUsed });
  return toSnapshot(runtime, next);
}

export function handleTurnLaunched(
  runtime: GoalRuntimeContext,
  turnId: number,
  origin: TurnStarted['origin'],
): void {
  runtime.send({ type: 'goal.turnLaunched', turnId });
  const machine = machineContextOf(runtime);
  let drivenGoalId: string | undefined;
  if (!machine.goalDrivenTurns.has(turnId)) {
    const state = runtime.getState().goal;
    const continuationGoalId = isGoalContinuationOrigin(origin)
      ? machine.pendingContinuationGoals.get(turnId)
      : undefined;
    if (continuationGoalId !== undefined && state?.goalId !== continuationGoalId) {
      drivenGoalId = continuationGoalId;
    } else if (state?.status === 'active' && blockIfBudgetReached(runtime, state) === null) {
      drivenGoalId = state.goalId;
    }
  }
  runtime.send({ type: 'goal.turnDriveResolved', turnId, drivenGoalId });
}

function adoptStarterTurn(runtime: GoalRuntimeContext, actor: GoalActor): void {
  const machine = machineContextOf(runtime);
  const turnId = machine.liveTurnId;
  if (turnId === undefined) return;
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active') return;
  runtime.send({
    type: 'goal.starterTurnAdopted',
    turnId,
    goalId: state.goalId,
    toolTarget: actor === 'model',
    turnBudgetExhausted: toSnapshot(runtime, state).budget.turnBudgetReached,
    adopt: machine.goalDrivenTurns.get(turnId) === undefined,
  });
}

export async function handleBeforeStep(
  runtime: GoalRuntimeContext,
  ctx: BeforeStepContext,
): Promise<void> {
  const machine = machineContextOf(runtime);
  const goalId = machine.goalDrivenTurns.get(ctx.turnId);
  if (goalId === undefined) return;
  if (machine.countedGoalTurns.has(ctx.turnId)) return;
  runtime.send({ type: 'goal.turnCounted', turnId: ctx.turnId });
  incrementGoalTurn(runtime, goalId);
}

export function handleUsageRecorded(
  runtime: GoalRuntimeContext,
  ctx: UsageRecordedContext,
): void {
  const source = ctx.source;
  if (source?.type !== 'turn') return;
  const goalId = machineContextOf(runtime).goalDrivenTurns.get(source.turnId);
  if (goalId === undefined) return;
  accountTokenUsage(runtime, ctx.usage.output, goalId);
}

export function handleAfterStep(runtime: GoalRuntimeContext, ctx: AfterStepContext): void {
  if (stopAfterBudgetReached(runtime, ctx)) return;
  enqueueGoalOutcomeContinuation(runtime, ctx);
}

function stopAfterBudgetReached(runtime: GoalRuntimeContext, ctx: AfterStepContext): boolean {
  const machine = machineContextOf(runtime);
  const goalId = goalTurnTarget(machine, ctx.turnId);
  const state = runtime.getState().goal;
  const budget = state === null ? null : toSnapshot(runtime, state).budget;
  const turnBudgetBlocksCurrentTurn =
    budget?.turnBudgetReached === true &&
    (machine.exhaustedTurnBudgetGoals.get(ctx.turnId) === goalId ||
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
  const maxSteps = runtime.get(IConfigService).get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
  if (
    ctx.finishReason === 'tool_calls' &&
    !machine.budgetGraceTurns.has(ctx.turnId) &&
    hasStepBudgetRemaining(maxSteps, ctx.step)
  ) {
    runtime.send({ type: 'goal.graceGranted', turnId: ctx.turnId });
    reminderOf(runtime).notify(GOAL_BUDGET_STOP_REMINDER, {
      variant: GOAL_BUDGET_STOP_REMINDER_NAME,
    });
    return true;
  }
  ctx.stopTurn = true;
  return true;
}

function enqueueGoalOutcomeContinuation(runtime: GoalRuntimeContext, ctx: AfterStepContext): void {
  const machine = machineContextOf(runtime);
  if (machine.goalOutcomeContinuationTurns.has(ctx.turnId)) return;
  const goalId = goalTurnTarget(machine, ctx.turnId);
  const outcomeGoalId = machine.goalOutcomeToolResultTurns.get(ctx.turnId);
  let recordContinuation = false;
  if (goalId !== undefined && outcomeGoalId === goalId) {
    const state = runtime.getState().goal;
    recordContinuation = state === null || state.goalId === goalId;
  }
  runtime.send({ type: 'goal.outcomeConsumed', turnId: ctx.turnId, recordContinuation });
  if (!recordContinuation) return;
  const maxSteps = runtime.get(IConfigService).get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
  if (!hasStepBudgetRemaining(maxSteps, ctx.step)) return;
  getLoopControl(runtime.agent).enqueue(new ContinuationStepRequest());
}

export function handleTurnEndedEvent(runtime: GoalRuntimeContext, event: TurnEnded): void {
  const goalId = goalTurnTarget(machineContextOf(runtime), event.turnId);
  void handleTurnEnded(runtime, event.turnId, { reason: event.reason, error: event.error }).catch(
    (error) => settleGoalAfterContinuationFailure(runtime, error, goalId),
  );
}

async function handleTurnEnded(
  runtime: GoalRuntimeContext,
  turnId: number,
  result: Pick<TurnEnded, 'reason' | 'error'>,
): Promise<void> {
  const machine = machineContextOf(runtime);
  const goalId = machine.goalDrivenTurns.get(turnId);
  const lifecycleGoalId = goalTurnTarget(machine, turnId);
  const starterTurn = machine.goalStarterTurns.has(turnId);
  const resumeContinuation = machine.resumeContinuation;
  runtime.send({ type: 'goal.turnEnded', turnId });
  if (resumeContinuation?.turnId === turnId && result.reason === 'cancelled') {
    const state = runtime.getState().goal;
    if (state === null || state.status !== 'active' || state.goalId !== resumeContinuation.goalId) {
      return;
    }
    if (blockIfBudgetReached(runtime, state) !== null) return;
    launchContinuationTurn(runtime, resumeContinuation.goalId);
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
    await settleAbnormalTurn(runtime, result, lifecycleGoalId);
    return;
  }
  if (starterTurn) incrementGoalTurn(runtime, goalId);

  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active' || state.goalId !== lifecycleGoalId) return;
  if (blockIfBudgetReached(runtime, state) !== null) return;
  launchContinuationTurn(runtime, lifecycleGoalId, stepCapped);
}

async function settleAbnormalTurn(
  runtime: GoalRuntimeContext,
  result: Pick<TurnEnded, 'reason' | 'error'>,
  goalId: string,
): Promise<boolean> {
  if (!isActiveGoal(runtime, goalId)) return false;
  if (result.reason === 'blocked') {
    await markBlocked(runtime, { reason: 'Blocked by UserPromptSubmit hook' });
    return true;
  }
  if (result.reason === 'cancelled') {
    await pauseOnInterrupt(runtime, { reason: 'Paused after interruption' });
    return true;
  }
  if (result.reason === 'failed') {
    await pauseActiveGoal(runtime, { reason: goalFailurePauseReason(result.error) });
    return true;
  }
  return false;
}

async function settleGoalAfterContinuationFailure(
  runtime: GoalRuntimeContext,
  error: unknown,
  goalId: string | undefined,
): Promise<void> {
  if (goalId === undefined || !isActiveGoal(runtime, goalId)) return;
  try {
    const reason = pauseReasonWithMessage(
      GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX,
      normalizeGoalErrorPayload(error).message,
    );
    await pauseActiveGoal(runtime, { reason }, 'system');
  } catch { }
}

export function isWaitForAvailable(runtime: GoalRuntimeContext): boolean {
  const tools = runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentTools);
  return (
    runtime.get(IFlagService).enabled(WAIT_FOR_FLAG_ID) &&
    tools.resolve('WaitFor') !== undefined &&
    tools.isActive('WaitFor')
  );
}

function launchContinuationTurn(
  runtime: GoalRuntimeContext,
  goalId: string,
  stepCapped = false,
): void {
  if (!isActiveGoal(runtime, goalId)) return;
  if (machineContextOf(runtime).pendingContinuation !== undefined) return;
  const prompt = stepCapped ? GOAL_STEP_CAP_CONTINUATION_PROMPT : GOAL_CONTINUATION_PROMPT;
  const message: ContextMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: isWaitForAvailable(runtime)
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
  const receipt = getLoopControl(runtime.agent).enqueue(request);
  const pending: PendingContinuation = { receipt, goalId };
  runtime.send({ type: 'goal.continuationPending', pending });
  void receipt.assigned
    .then(({ turn }) => {
      runtime.send({ type: 'goal.continuationAssigned', pending, turnId: turn.id });
      return turn.result;
    })
    .finally(() => {
      runtime.send({ type: 'goal.continuationSettled', pending });
    });
}

function canLaunchContinuation(runtime: GoalRuntimeContext): boolean {
  const machine = machineContextOf(runtime);
  if (machine.liveTurnId !== undefined || machine.pendingContinuation !== undefined) return false;
  const status = getLoopControl(runtime.agent).status();
  return status.state === 'idle' && !status.hasPendingRequests;
}

function isActiveGoal(runtime: GoalRuntimeContext, goalId: string): boolean {
  const state = runtime.getState().goal;
  return state?.status === 'active' && state.goalId === goalId;
}

function isStaleGoalToolCall(runtime: GoalRuntimeContext, ctx: BeforeToolExecuteEvent): boolean {
  const toolName = ctx.toolCall.name;
  if (!isGoalMutationTool(toolName)) return false;
  const goalId = goalTurnTarget(machineContextOf(runtime), ctx.turnId);
  if (goalId === undefined) return false;
  return runtime.getState().goal?.goalId !== goalId;
}

function goalTurnTarget(machine: GoalMachineContext, turnId: number): string | undefined {
  return machine.goalTurnTargets.get(turnId) ?? machine.goalDrivenTurns.get(turnId);
}

function stopPursuit(
  runtime: GoalRuntimeContext,
  preserveLiveContinuation: boolean,
  cancellationReason?: unknown,
): void {
  const machine = machineContextOf(runtime);
  const pending = machine.pendingContinuation;
  const preserved = preserveLiveContinuation && pending?.turnId === machine.liveTurnId;
  runtime.send({ type: 'goal.pursuitStopped', clearPendingContinuation: !preserved });
  if (preserved || pending === undefined) return;
  const cancellation = cancellationReason ?? abortError('Goal continuation cancelled');
  const aborted = pending.receipt.abort(cancellation);
  if (!aborted && pending.turnId !== undefined) {
    getLoopControl(runtime.agent).cancel(pending.turnId, cancellation);
  }
}

export function normalizeAfterReplay(runtime: GoalRuntimeContext): void {
  appendForkClearedReminder(runtime);
  runtime.send({ type: 'goal.pursuitStopped', clearPendingContinuation: false });
  const state = runtime.getState().goal;
  if (state === null) return;
  if (state.status === 'complete') {
    clearInternal(runtime, 'runtime', { emit: false, track: false });
    return;
  }
  if (state.status !== 'active') return;

  const reason = 'Paused after agent resume';
  void runtime.dispatch(
    new GoalUpdate({
      agentId: runtime.agent.agentId,
      status: 'paused',
      reason,
      wallClockMs: liveWallClockMs(runtime, state),
      actor: 'runtime',
    }),
  );
  trackStatusChanged(runtime, requireState(runtime), 'runtime');
}

function appendForkClearedReminder(runtime: GoalRuntimeContext): void {
  if (!runtime.getState().forkNotice.reminderPending) return;
  reminderOf(runtime).notify(GOAL_FORK_CLEARED_REMINDER, {
    variant: GOAL_FORK_CLEARED_REMINDER_NAME,
  });
}

function clearInternal(
  runtime: GoalRuntimeContext,
  actor: GoalActor,
  opts: {
    readonly emit?: boolean;
    readonly track?: boolean;
    readonly preserveLiveContinuation?: boolean;
  } = {},
): void {
  if (runtime.getState().goal === null) return;
  stopPursuit(runtime, opts.preserveLiveContinuation === true);
  void runtime.dispatch(new GoalClear({ agentId: runtime.agent.agentId }));
  if (opts.emit !== false) emitGoalUpdated(runtime, null);
  if (opts.track !== false) {
    runtime.get(IAgentHostService).of(runtime.agent).telemetry.track2('goal_cleared', { actor });
  }
}

function applyLifecycle(
  runtime: GoalRuntimeContext,
  state: GoalState,
  status: GoalStatus,
  reason: string | undefined,
  actor: GoalActor,
  opts: {
    readonly preserveLiveContinuation?: boolean;
    readonly cancellationReason?: unknown;
  } = {},
): GoalSnapshot {
  const wallClockMs = liveWallClockMs(runtime, state);
  const wallClockResumedAt = status === 'active' ? Date.now() : undefined;
  if (status === 'active') {
    runtime.send({
      type: 'goal.wallClockStarted',
      at: runtime.get(IGoalDeadlineScheduler).now(),
    });
  } else if (state.status === 'active') {
    stopPursuit(runtime, opts.preserveLiveContinuation === true, opts.cancellationReason);
  }
  void runtime.dispatch(
    new GoalUpdate({
      agentId: runtime.agent.agentId,
      status,
      reason,
      wallClockMs,
      wallClockResumedAt,
      actor,
    }),
  );
  const next = requireState(runtime);
  if (status === 'active') adoptStarterTurn(runtime, actor);
  if (status === 'active') refreshWallClockDeadline(runtime);
  emitGoalUpdated(runtime, toSnapshot(runtime, next), { kind: 'lifecycle', status, reason, actor });
  trackStatusChanged(runtime, next, actor);
  return toSnapshot(runtime, next);
}

function trackStatusChanged(
  runtime: GoalRuntimeContext,
  state: GoalState,
  actor: GoalActor,
): void {
  runtime.get(IAgentHostService).of(runtime.agent).telemetry.track2('goal_status_changed', {
    actor,
    status: state.status,
    turns_used: state.turnsUsed,
    tokens_used: state.tokensUsed,
    wall_clock_ms: liveWallClockMs(runtime, state),
    ...budgetTelemetryProperties(state.budgetLimits),
  });
}

function requireState(runtime: GoalRuntimeContext): GoalState {
  const state = runtime.getState().goal;
  if (state === null) {
    throw new Error2(ErrorCodes.GOAL_NOT_FOUND, 'No current goal');
  }
  return state;
}

function emitGoalUpdated(
  runtime: GoalRuntimeContext,
  snapshot: GoalSnapshot | null,
  change?: GoalChange,
): void {
  void runtime.dispatch(
    new GoalUpdated({ agentId: runtime.agent.agentId, snapshot, change }),
  );
}

function liveWallClockMs(runtime: GoalRuntimeContext, state: GoalState): number {
  const startedAt = machineContextOf(runtime).liveWallClockStartedAt;
  if (state.status === 'active' && startedAt !== undefined) {
    return (
      state.wallClockMs + Math.max(0, runtime.get(IGoalDeadlineScheduler).now() - startedAt)
    );
  }
  if (state.status === 'active' && state.wallClockResumedAt !== undefined) {
    return state.wallClockMs + Math.max(0, Date.now() - state.wallClockResumedAt);
  }
  return state.wallClockMs;
}

function statsOf(runtime: GoalRuntimeContext, state: GoalState): GoalChangeStats {
  return {
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs: liveWallClockMs(runtime, state),
  };
}

function toSnapshot(runtime: GoalRuntimeContext, state: GoalState): GoalSnapshot {
  const wallClockMs = liveWallClockMs(runtime, state);
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

function blockIfBudgetReached(runtime: GoalRuntimeContext, state: GoalState): GoalSnapshot | null {
  if (state.status !== 'active') return null;
  const reason = goalBudgetBlockReason(toSnapshot(runtime, state).budget);
  if (reason === undefined) return null;
  return applyLifecycle(runtime, state, 'blocked', reason, 'runtime', {
    preserveLiveContinuation: true,
  });
}

function refreshWallClockDeadline(runtime: GoalRuntimeContext): void {
  runtime.send({ type: 'goal.deadline.refresh' });
}

export function wallClockDeadlineDelay(runtime: GoalRuntimeContext): number | undefined {
  const state = runtime.getState().goal;
  const budgetMs = state?.budgetLimits.wallClockBudgetMs;
  if (
    state === null ||
    state.status !== 'active' ||
    budgetMs === undefined ||
    machineContextOf(runtime).liveWallClockStartedAt === undefined
  ) {
    return undefined;
  }
  return Math.max(0, budgetMs - liveWallClockMs(runtime, state));
}

export function handleWallClockDeadline(runtime: GoalRuntimeContext): void {
  const state = runtime.getState().goal;
  if (state === null || state.status !== 'active') return;
  const budgetMs = state.budgetLimits.wallClockBudgetMs;
  if (budgetMs === undefined) return;
  if (liveWallClockMs(runtime, state) < budgetMs) {
    refreshWallClockDeadline(runtime);
    return;
  }
  const reason = goalBudgetBlockReason(toSnapshot(runtime, state).budget);
  if (reason === undefined) return;
  const cancellation = abortError(reason);
  const machine = machineContextOf(runtime);
  const liveTurnId = machine.liveTurnId;
  const pendingTurnId = machine.pendingContinuation?.turnId;
  applyLifecycle(runtime, state, 'blocked', reason, 'runtime', {
    cancellationReason: cancellation,
  });
  if (liveTurnId !== undefined && liveTurnId !== pendingTurnId) {
    getLoopControl(runtime.agent).cancel(liveTurnId, cancellation);
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

export function handleGoalStartApproval(
  runtime: GoalRuntimeContext,
  event: BeforeToolExecuteEvent,
): void {
  const permissionMode = runtime
    .get(IAgentLifecycleService)
    .resolve(runtime.agent, AgentPermissionMode);
  if (
    event.toolCall.name !== 'CreateGoal' ||
    permissionMode.mode() === 'auto' ||
    event.execution.display?.kind !== 'goal_start'
  ) return;
  event.waitUntil(async () => runtime.get(ISessionToolApprovalService).of(runtime.agent).requestToolApproval(
    event,
    {
      kind: 'ask',
      resolveApproval: (approval) => {
        if (approval.decision !== 'approved') return undefined;
        const mode = toGoalStartReviewPermissionMode(approval.selectedLabel);
        if (mode === undefined) return undefined;
        const contractMode = toContractMode(mode);
        if (contractMode !== permissionMode.mode()) void permissionMode.changeMode(contractMode);
        return undefined;
      },
    },
    'goal-start-review-ask',
  ));
}

export function handleGoalToolVeto(
  runtime: GoalRuntimeContext,
  event: BeforeToolExecuteEvent,
): void {
  if (isStaleGoalToolCall(runtime, event)) {
    event.veto({ output: GOAL_STALE_TOOL_RESULT });
    return;
  }
  if (machineContextOf(runtime).budgetGraceTurns.has(event.turnId)) {
    event.veto({ output: GOAL_BUDGET_TOOLS_REJECTED_MESSAGE });
  }
}

export function handleToolCompleted(
  runtime: GoalRuntimeContext,
  tool: ToolDidExecuteContext,
): void {
  const goalId = goalTurnTarget(machineContextOf(runtime), tool.turnId);
  if (
    goalId !== undefined &&
    isTerminalUpdateGoalResult(tool.toolCall.name, tool.args, tool.result)
  ) {
    runtime.send({ type: 'goal.outcomeToolResult', turnId: tool.turnId, goalId });
  }
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
