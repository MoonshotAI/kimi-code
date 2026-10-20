import {
  createFeature,
  useAgent,
  useSession,
  useStepContinuing,
  useStepStarting,
  useToolPermitting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  createHistoryMessageBuilder,
  createUserEntry,
  type AssistantEntry,
  type HistoryMessage,
  type UserEntry,
} from '@moonshot-ai/agent-core/history/index';
import {
  createFacadeToken,
  useCleanup,
  useExpose,
  useFire,
  useReady,
  type ComputedRef,
  type RuntimeEvent,
} from '@moonshot-ai/agent-core/kernel/index';
import {
  MAX_STEPS_REASON,
  type Cause,
  type StepContinuingVerdict,
  type StepStartingDecision,
  type TurnOutcome,
} from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID } from '@moonshot-ai/agent-core/session/index';

import { useInteractions } from '#/features/interaction/index';
import { useAgentRuntime, useAgentTools, useFeatureStore, useLoopEvent } from '#/runtime/index';

import {
  GOAL_ALREADY_EXISTS,
  GOAL_NOT_FOUND,
  GOAL_NOT_RESUMABLE,
  GOAL_OBJECTIVE_EMPTY,
  GOAL_OBJECTIVE_TOO_LONG,
  GOAL_STATUS_INVALID,
  GOAL_UNSUPPORTED_AGENT,
  GoalError,
} from './errors';
import { createGoalGuard } from './guard';
import { goalReminderText, GOAL_WAIT_FOR_GUIDANCE } from './injection';
import {
  GOAL_BUDGET_BLOCK_PREFIX,
  GOAL_BUDGET_STOP_REMINDER,
  GOAL_BUDGET_STOP_REMINDER_NAME,
  GOAL_CANCELLED_REMINDER,
  GOAL_CANCELLED_REMINDER_NAME,
  GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX,
  GOAL_CONTINUATION_ORIGIN,
  GOAL_CONTINUATION_PROMPT,
  GOAL_PROVIDER_API_PAUSE_PREFIX,
  GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX,
  GOAL_RATE_LIMIT_PAUSE_REASON,
  GOAL_REMIND_KEY,
  GOAL_RUNTIME_PAUSE_PREFIX,
  GOAL_STEP_CAP_CONTINUATION_PROMPT,
  isGoalContinuationOrigin,
  MAX_GOAL_COMPLETION_CRITERION_LENGTH,
  MAX_GOAL_OBJECTIVE_LENGTH,
} from './prompts';
import {
  GOAL_CLEAR,
  GOAL_CREATE,
  GOAL_UPDATE,
  goalProjection,
  type GoalModelState,
  type GoalState,
} from './projection';
import { createCreateGoalTool } from './tools/create-goal';
import { createGetGoalTool } from './tools/get-goal';
import { createSetGoalBudgetTool } from './tools/set-goal-budget';
import { createUpdateGoalTool } from './tools/update-goal';
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalChange,
  GoalChangeStats,
  GoalReasonInput,
  GoalSnapshot,
  GoalStatus,
  GoalToolResult,
  ResumeGoalInput,
} from './types';

export interface GoalUpdatedEvent extends RuntimeEvent {
  readonly type: 'goal.updated';
  readonly snapshot: GoalSnapshot | null;
  readonly change?: GoalChange;
}

export interface GoalFace {
  readonly state: ComputedRef<GoalModelState>;
  getGoal(): GoalToolResult;
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
}

export const GoalRef = createFacadeToken<GoalFace>('goal');

export interface CreateGoalProps {
  readonly now?: () => number;
  readonly wallNow?: () => number;
}

interface PendingContinuation {
  readonly promptId: string;
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
  readonly classifiedTurns: Set<number>;
  readonly countedGoalTurns: Set<number>;
  readonly goalStarterTurns: Set<number>;
  readonly budgetGraceTurns: Set<number>;
  readonly budgetStopInjectedTurns: Set<number>;
  readonly goalOutcomeToolResultTurns: Map<number, string>;
  readonly goalTurnTargets: Map<number, string>;
  liveWallClockStartedAt?: number;
  resumeContinuation?: ResumeContinuation;
  lastRemindedTurnId?: number;
  deadline?: ReturnType<typeof setTimeout>;
}

function defaultNow(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function noop(): void {}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function createGoal(props: CreateGoalProps = {}): Feature<void, GoalUpdatedEvent> {
  const now = props.now ?? defaultNow;
  const wallNow = props.wallNow ?? Date.now;
  return createFeature<GoalUpdatedEvent>('goal', {
    agent() {
      const agent = useAgent();
      const store = useFeatureStore('agent', 'goal', goalProjection);
      const state = store.state;
      const runtime = useAgentRuntime();
      const fire = useFire();
      const waitForAvailable = (): boolean => {
        const tool = runtime.tools.get('WaitFor');
        return tool !== undefined && tool.deferred !== true;
      };
      const effects: GoalEffectState = {
        goalDrivenTurns: new Map(),
        classifiedTurns: new Set(),
        countedGoalTurns: new Set(),
        goalStarterTurns: new Set(),
        budgetGraceTurns: new Set(),
        budgetStopInjectedTurns: new Set(),
        goalOutcomeToolResultTurns: new Map(),
        goalTurnTargets: new Map(),
      };

      let storeReady = false;
      let chain: Promise<void> = Promise.resolve();
      const run = <T>(op: () => Promise<T>): Promise<T> => {
        const result = chain.then(op);
        chain = result.then(noop, noop);
        return result;
      };
      const enqueue = (op: () => Promise<unknown>): void => {
        void run(op).catch(noop);
      };

      const current = (): GoalModelState => state.value;

      const assertSupportedAgent = (): void => {
        if (agent.id === MAIN_AGENT_ID) return;
        throw new GoalError(GOAL_UNSUPPORTED_AGENT, 'Goals are only supported by the main agent');
      };

      const liveWallClockMs = (goal: GoalState): number => {
        if (goal.status === 'active' && effects.liveWallClockStartedAt !== undefined) {
          return goal.wallClockMs + Math.max(0, now() - effects.liveWallClockStartedAt);
        }
        return goal.wallClockMs;
      };

      const computeBudgetReport = (goal: GoalState, wallClockMs: number): GoalBudgetReport => {
        const tokenBudget = goal.budgetLimits.tokenBudget ?? null;
        const turnBudget = goal.budgetLimits.turnBudget ?? null;
        const wallClockBudgetMs = goal.budgetLimits.wallClockBudgetMs ?? null;
        const tokenBudgetReached = tokenBudget !== null && goal.tokensUsed >= tokenBudget;
        const turnBudgetReached = turnBudget !== null && goal.turnsUsed >= turnBudget;
        const wallClockBudgetReached =
          wallClockBudgetMs !== null && wallClockMs >= wallClockBudgetMs;
        return {
          tokenBudget,
          turnBudget,
          wallClockBudgetMs,
          remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - goal.tokensUsed),
          remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - goal.turnsUsed),
          remainingWallClockMs:
            wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - wallClockMs),
          tokenBudgetReached,
          turnBudgetReached,
          wallClockBudgetReached,
          overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
        };
      };

      const toSnapshot = (goal: GoalState): GoalSnapshot => {
        const wallClockMs = liveWallClockMs(goal);
        return {
          goalId: goal.goalId,
          objective: goal.objective,
          completionCriterion: goal.completionCriterion,
          status: goal.status,
          turnsUsed: goal.turnsUsed,
          tokensUsed: goal.tokensUsed,
          wallClockMs,
          budget: computeBudgetReport(goal, wallClockMs),
          terminalReason: goal.terminalReason,
        };
      };

      const statsOf = (goal: GoalState): GoalChangeStats => ({
        turnsUsed: goal.turnsUsed,
        tokensUsed: goal.tokensUsed,
        wallClockMs: liveWallClockMs(goal),
      });

      const requireState = (): GoalState => {
        const goal = current();
        if (goal === null) throw new GoalError(GOAL_NOT_FOUND, 'No current goal');
        return goal;
      };

      const isActiveGoal = (goalId: string): boolean => {
        const goal = current();
        return goal?.status === 'active' && goal.goalId === goalId;
      };

      const matchesGoal = (goal: GoalState, goalId: string | undefined): boolean =>
        goalId === undefined || goal.goalId === goalId;

      const goalTurnTarget = (turnId: number): string | undefined =>
        effects.goalTurnTargets.get(turnId) ?? effects.goalDrivenTurns.get(turnId);

      const emitGoalUpdated = (
        snapshot: GoalSnapshot | null,
        change?: GoalUpdatedEvent['change'],
      ): void => {
        fire({ type: 'goal.updated', snapshot, change });
      };

      const clearDeadlineTimer = (): void => {
        if (effects.deadline !== undefined) {
          clearTimeout(effects.deadline);
          effects.deadline = undefined;
        }
      };

      const wallClockDeadlineDelay = (): number | undefined => {
        const goal = current();
        const budgetMs = goal?.budgetLimits.wallClockBudgetMs;
        if (
          goal === null ||
          goal.status !== 'active' ||
          budgetMs === undefined ||
          effects.liveWallClockStartedAt === undefined
        ) {
          return undefined;
        }
        return Math.min(2_147_483_647, Math.max(0, budgetMs - liveWallClockMs(goal)));
      };

      const refreshDeadline = (): void => {
        clearDeadlineTimer();
        const delay = wallClockDeadlineDelay();
        if (delay === undefined) return;
        const timer = setTimeout(() => {
          if (effects.deadline === timer) effects.deadline = undefined;
          enqueue(handleWallClockDeadline);
        }, delay);
        timer.unref?.();
        effects.deadline = timer;
      };

      const goalBudgetBlockReason = (budget: GoalBudgetReport): string | undefined => {
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
        return reached.length === 0
          ? undefined
          : `Blocked after goal budget reached: ${reached.join(', ')}`;
      };

      const cancelPendingContinuation = (
        preserveLiveContinuation: boolean,
        reason?: unknown,
      ): void => {
        const pending = effects.pendingContinuation;
        if (preserveLiveContinuation && pending?.turnId === effects.liveTurnId) return;
        effects.pendingContinuation = undefined;
        if (pending === undefined) return;
        const cancellation = reason ?? abortError('Goal continuation cancelled');
        if (pending.turnId === undefined) {
          agent.loop.cancel(pending.promptId);
          return;
        }
        if (pending.turnId === effects.liveTurnId) agent.loop.abort(cancellation);
      };

      const applyBudgetBlock = async (
        goal: GoalState,
        reason: string,
      ): Promise<GoalSnapshot | null> => {
        const live = current();
        if (live === null || live.goalId !== goal.goalId || live.status !== 'active') return null;
        const blocked = await applyLifecycle(live, 'blocked', reason, 'runtime', {
          preserveLiveContinuation: true,
        });
        return blocked;
      };

      const blockIfBudgetReached = async (goal: GoalState): Promise<GoalSnapshot | null> => {
        if (goal.status !== 'active') return null;
        const reason = goalBudgetBlockReason(toSnapshot(goal).budget);
        if (reason === undefined) return null;
        return applyBudgetBlock(goal, reason);
      };

      const applyLifecycle = async (
        goal: GoalState,
        status: GoalStatus,
        reason: string | undefined,
        actor: GoalActor,
        opts: {
          readonly preserveLiveContinuation?: boolean;
          readonly cancellationReason?: unknown;
        } = {},
      ): Promise<GoalSnapshot> => {
        const wallClockMs = liveWallClockMs(goal);
        const wallClockResumedAt = status === 'active' ? wallNow() : undefined;
        if (status === 'active') {
          effects.liveWallClockStartedAt = now();
        } else if (goal.status === 'active') {
          effects.resumeContinuation = undefined;
          cancelPendingContinuation(
            opts.preserveLiveContinuation === true,
            opts.cancellationReason,
          );
          clearDeadlineTimer();
          effects.liveWallClockStartedAt = undefined;
        }
        await store.dispatch([
          {
            type: GOAL_UPDATE,
            status,
            reason,
            wallClockMs,
            wallClockResumedAt,
            actor,
          },
        ]);
        const next = requireState();
        if (status === 'active') adoptStarterTurn(actor);
        if (status === 'active') refreshDeadline();
        const snapshot = toSnapshot(next);
        emitGoalUpdated(snapshot, { kind: 'lifecycle', status, reason, actor });
        return snapshot;
      };

      const clearInternal = async (
        opts: { readonly emit?: boolean; readonly preserveLiveContinuation?: boolean } = {},
      ): Promise<void> => {
        if (current() === null) return;
        effects.resumeContinuation = undefined;
        cancelPendingContinuation(opts.preserveLiveContinuation === true);
        clearDeadlineTimer();
        effects.liveWallClockStartedAt = undefined;
        await store.dispatch([{ type: GOAL_CLEAR }]);
        if (opts.emit !== false) emitGoalUpdated(null);
      };

      const pauseActiveGoal = async (
        input: GoalReasonInput,
        actor: GoalActor,
      ): Promise<GoalSnapshot | null> => {
        const goal = current();
        if (goal === null || goal.status !== 'active') return null;
        return applyLifecycle(goal, 'paused', input.reason, actor);
      };

      const settleGoalAfterContinuationFailure = async (
        error: unknown,
        goalId: string | undefined,
      ): Promise<void> => {
        if (goalId === undefined || !isActiveGoal(goalId)) return;
        try {
          const reason = pauseReasonWithMessage(
            GOAL_CONTINUATION_FAILURE_PAUSE_PREFIX,
            error instanceof Error ? error.message : String(error),
          );
          await pauseActiveGoal({ reason }, 'system');
        } catch {
          noop();
        }
      };

      const incrementGoalTurn = async (goalId?: string): Promise<GoalSnapshot | null> => {
        const goal = current();
        if (goal === null || goal.status !== 'active' || !matchesGoal(goal, goalId)) return null;
        await store.dispatch([{ type: GOAL_UPDATE, turnsUsed: goal.turnsUsed + 1 }]);
        const next = requireState();
        const snapshot = toSnapshot(next);
        emitGoalUpdated(snapshot);
        return snapshot;
      };

      const accountTokenUsage = async (
        tokenDelta: number,
        goalId?: string,
      ): Promise<GoalSnapshot | null> => {
        const goal = current();
        if (goal === null || goal.status !== 'active' || !matchesGoal(goal, goalId)) return null;
        const tokensUsed = goal.tokensUsed + Math.max(0, tokenDelta);
        await store.dispatch([{ type: GOAL_UPDATE, tokensUsed }]);
        const next = requireState();
        return (await blockIfBudgetReached(next)) ?? toSnapshot(next);
      };

      const adoptStarterTurn = (actor: GoalActor): void => {
        const turnId = effects.liveTurnId;
        if (turnId === undefined) return;
        const goal = current();
        if (goal === null || goal.status !== 'active') return;
        if (actor === 'model') effects.goalTurnTargets.set(turnId, goal.goalId);
        if (effects.goalDrivenTurns.has(turnId)) return;
        effects.goalDrivenTurns.set(turnId, goal.goalId);
        effects.countedGoalTurns.add(turnId);
        effects.goalStarterTurns.add(turnId);
      };

      const canLaunchContinuation = (): boolean => {
        if (effects.liveTurnId !== undefined || effects.pendingContinuation !== undefined) {
          return false;
        }
        return agent.loop.state.status !== 'running';
      };

      const launchContinuationTurn = (goalId: string, stepCapped = false): void => {
        if (!isActiveGoal(goalId)) return;
        if (effects.pendingContinuation !== undefined) return;
        const prompt = stepCapped ? GOAL_STEP_CAP_CONTINUATION_PROMPT : GOAL_CONTINUATION_PROMPT;
        const text = waitForAvailable() ? `${prompt} ${GOAL_WAIT_FOR_GUIDANCE}` : prompt;
        const promptId = crypto.randomUUID();
        agent.loop.submit(
          createUserEntry(createHistoryMessageBuilder().plain(text).userMessage(), {
            source: 'input',
            promptId,
            origin: GOAL_CONTINUATION_ORIGIN,
          }),
        );
        effects.pendingContinuation = { promptId, goalId };
      };

      const handleWallClockDeadline = async (): Promise<void> => {
        const goal = current();
        if (goal === null || goal.status !== 'active') return;
        const budgetMs = goal.budgetLimits.wallClockBudgetMs;
        if (budgetMs === undefined) return;
        if (liveWallClockMs(goal) < budgetMs) {
          refreshDeadline();
          return;
        }
        const reason = goalBudgetBlockReason(toSnapshot(goal).budget);
        if (reason === undefined) return;
        const cancellation = abortError(reason);
        const liveTurnId = effects.liveTurnId;
        const pendingTurnId = effects.pendingContinuation?.turnId;
        await applyLifecycle(goal, 'blocked', reason, 'runtime', {
          cancellationReason: cancellation,
        });
        if (liveTurnId !== undefined && liveTurnId !== pendingTurnId) {
          agent.loop.abort(cancellation);
        }
      };

      const injectReminder = (turnId: number): void => {
        if (effects.lastRemindedTurnId === turnId) return;
        effects.lastRemindedTurnId = turnId;
        const goal = current();
        if (goal === null) return;
        const text = goalReminderText(toSnapshot(goal), waitForAvailable());
        if (text === undefined) return;
        const message = createHistoryMessageBuilder().systemReminder(text).userMessage();
        queueMicrotask(() => {
          agent.loop.remind(
            createUserEntry(message, { source: 'reminder', key: GOAL_REMIND_KEY }),
          );
        });
      };

      const settleAbnormalTurn = async (
        outcome: Extract<TurnOutcome, { readonly type: 'failed' | 'aborted' }>,
        goalId: string,
      ): Promise<void> => {
        if (!isActiveGoal(goalId)) return;
        if (outcome.type === 'aborted') {
          await pauseActiveGoal({ reason: 'Paused after interruption' }, 'user');
          return;
        }
        await pauseActiveGoal({ reason: goalFailurePauseReason(outcome.error) }, 'runtime');
      };

      const settleHookBlockedTurn = async (cause: Cause, goalId: string): Promise<void> => {
        if (!isActiveGoal(goalId)) return;
        const goal = current();
        if (goal === null || goal.status !== 'active') return;
        await applyLifecycle(goal, 'blocked', cause.message ?? cause.reason, 'runtime', {
          preserveLiveContinuation: true,
        });
      };

      const clearTurnTracking = (
        turnId: number,
      ): {
        readonly goalId?: string;
        readonly lifecycleGoalId?: string;
        readonly starterTurn: boolean;
        readonly outcomeGoalId?: string;
      } => {
        if (effects.pendingContinuation?.turnId === turnId) {
          effects.pendingContinuation = undefined;
        }
        if (effects.liveTurnId === turnId) effects.liveTurnId = undefined;
        const goalId = effects.goalDrivenTurns.get(turnId);
        const lifecycleGoalId = goalTurnTarget(turnId);
        const starterTurn = effects.goalStarterTurns.delete(turnId);
        const outcomeGoalId = effects.goalOutcomeToolResultTurns.get(turnId);
        effects.goalOutcomeToolResultTurns.delete(turnId);
        effects.goalDrivenTurns.delete(turnId);
        effects.classifiedTurns.delete(turnId);
        effects.countedGoalTurns.delete(turnId);
        effects.budgetGraceTurns.delete(turnId);
        effects.budgetStopInjectedTurns.delete(turnId);
        effects.goalTurnTargets.delete(turnId);
        return { goalId, lifecycleGoalId, starterTurn, outcomeGoalId };
      };

      const getGoal = (): GoalToolResult => {
        assertSupportedAgent();
        const goal = current();
        return { goal: goal === null ? null : toSnapshot(goal) };
      };

      const createGoalFace = (input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> =>
        run(async () => {
          assertSupportedAgent();
          const objective = input.objective.trim();
          if (objective.length === 0) {
            throw new GoalError(GOAL_OBJECTIVE_EMPTY, 'Goal objective cannot be empty');
          }
          if (objective.length > MAX_GOAL_OBJECTIVE_LENGTH) {
            throw new GoalError(
              GOAL_OBJECTIVE_TOO_LONG,
              `Goal objective cannot exceed ${MAX_GOAL_OBJECTIVE_LENGTH} characters. Put long content in a file and reference the file path.`,
            );
          }
          if (current() !== null) {
            if (input.replace !== true) {
              throw new GoalError(
                GOAL_ALREADY_EXISTS,
                'A goal already exists; use replace to start a new one',
              );
            }
            await clearInternal();
          }
          await store.dispatch([
            {
              type: GOAL_CREATE,
              goalId: crypto.randomUUID(),
              objective,
              completionCriterion: normalizeCompletionCriterion(input.completionCriterion),
              wallClockResumedAt: wallNow(),
            },
          ]);
          effects.liveWallClockStartedAt = now();
          adoptStarterTurn(actor);
          const goal = requireState();
          refreshDeadline();
          const snapshot = toSnapshot(goal);
          emitGoalUpdated(snapshot);
          return snapshot;
        });

      const pauseGoal = (input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> =>
        run(async () => {
          assertSupportedAgent();
          const goal = requireState();
          if (goal.status === 'paused') return toSnapshot(goal);
          if (goal.status !== 'active') {
            throw new GoalError(
              GOAL_STATUS_INVALID,
              `Cannot pause a goal in status "${goal.status}"`,
            );
          }
          return applyLifecycle(goal, 'paused', input.reason, actor);
        });

      const resumeGoal = (input: ResumeGoalInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> =>
        run(async () => {
          assertSupportedAgent();
          const goal = requireState();
          if (goal.status === 'active') return toSnapshot(goal);
          if (goal.status !== 'paused' && goal.status !== 'blocked') {
            throw new GoalError(
              GOAL_NOT_RESUMABLE,
              `Cannot resume a goal in status "${goal.status}"`,
            );
          }
          const continuePaused =
            actor === 'user' && goal.status === 'paused' && input.continueIfPaused === true;
          const shouldContinue =
            continuePaused ||
            (actor === 'user' && goal.status === 'blocked' && input.continueIfBlocked === true);
          const snapshot = await applyLifecycle(goal, 'active', input.reason, actor);
          if (!shouldContinue) return snapshot;
          const blocked = await blockIfBudgetReached(requireState());
          if (blocked !== null) return blocked;
          if (canLaunchContinuation()) {
            try {
              launchContinuationTurn(goal.goalId);
            } catch (error) {
              await settleGoalAfterContinuationFailure(error, goal.goalId);
              throw error;
            }
          } else if (continuePaused && effects.liveTurnId !== undefined) {
            effects.resumeContinuation = { turnId: effects.liveTurnId, goalId: goal.goalId };
          }
          return snapshot;
        });

      const setBudgetLimits = (
        input: { readonly budgetLimits: GoalBudgetLimits },
        _actor: GoalActor = 'user',
      ): Promise<GoalSnapshot> =>
        run(async () => {
          assertSupportedAgent();
          const goal = requireState();
          const budgetLimits = { ...goal.budgetLimits, ...input.budgetLimits };
          await store.dispatch([{ type: GOAL_UPDATE, budgetLimits }]);
          const next = requireState();
          emitGoalUpdated(toSnapshot(next));
          const blocked = await blockIfBudgetReached(next);
          if (blocked !== null) return blocked;
          refreshDeadline();
          return toSnapshot(next);
        });

      const cancelGoal = (input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> =>
        run(async () => {
          assertSupportedAgent();
          const goal = requireState();
          const snapshot = toSnapshot(goal);
          if (goal.status === 'active' && effects.liveTurnId !== undefined) {
            agent.loop.abort(abortError('Goal cancelled'));
          }
          await clearInternal();
          if (actor === 'user') {
            agent.loop.remind(
              createUserEntry(
                createHistoryMessageBuilder().systemReminder(GOAL_CANCELLED_REMINDER).userMessage(),
                { source: 'reminder', key: GOAL_CANCELLED_REMINDER_NAME },
              ),
            );
          }
          return snapshot;
        });

      const markBlocked = (
        input: GoalReasonInput = {},
        actor: GoalActor = 'runtime',
      ): Promise<GoalSnapshot | null> =>
        run(async () => {
          assertSupportedAgent();
          const goal = current();
          if (goal === null || goal.status !== 'active') return null;
          return applyLifecycle(goal, 'blocked', input.reason, actor, {
            preserveLiveContinuation: true,
          });
        });

      const markComplete = (
        input: GoalReasonInput = {},
        actor: GoalActor = 'model',
      ): Promise<GoalSnapshot | null> =>
        run(async () => {
          assertSupportedAgent();
          const goal = current();
          if (goal === null || goal.status !== 'active') return null;
          await store.dispatch([
            {
              type: GOAL_UPDATE,
              status: 'complete',
              reason: input.reason,
              wallClockMs: liveWallClockMs(goal),
              actor,
            },
          ]);
          const completed = requireState();
          const snapshot = toSnapshot(completed);
          emitGoalUpdated(snapshot, {
            kind: 'completion',
            status: 'complete',
            reason: input.reason,
            stats: statsOf(completed),
            actor,
          });
          await clearInternal({ preserveLiveContinuation: true });
          return snapshot;
        });

      const pauseOnInterrupt = (input: GoalReasonInput = {}): Promise<GoalSnapshot | null> =>
        run(async () => {
          assertSupportedAgent();
          return pauseActiveGoal(input, 'user');
        });

      const stepStarted = (turnId: number, messages: readonly HistoryMessage[]): StepStartingDecision | undefined => {
        if (effects.budgetGraceTurns.has(turnId) && !effects.budgetStopInjectedTurns.has(turnId)) {
          effects.budgetStopInjectedTurns.add(turnId);
          const reminder = createUserEntry(
            createHistoryMessageBuilder().systemReminder(GOAL_BUDGET_STOP_REMINDER).userMessage(),
            { source: 'reminder', key: GOAL_BUDGET_STOP_REMINDER_NAME },
          );
          return { messages: [...messages, reminder] };
        }
        injectReminder(turnId);
        const goalId = effects.goalDrivenTurns.get(turnId);
        if (goalId !== undefined && !effects.countedGoalTurns.has(turnId)) {
          effects.countedGoalTurns.add(turnId);
          enqueue(() => incrementGoalTurn(goalId));
        }
        return undefined;
      };

      const budgetStepContinuing = (turnId: number): StepContinuingVerdict | undefined => {
        const goalId = goalTurnTarget(turnId);
        if (goalId === undefined) return undefined;
        const goal = current();
        if (goal === null || goal.goalId !== goalId) return undefined;
        const budget = toSnapshot(goal).budget;
        const blockedWithBudget =
          goal.status === 'blocked' &&
          goal.terminalReason?.startsWith(GOAL_BUDGET_BLOCK_PREFIX) === true;
        const turnBudgetBlocks =
          budget.turnBudgetReached && (effects.goalDrivenTurns.has(turnId) || blockedWithBudget);
        if (!budget.tokenBudgetReached && !budget.wallClockBudgetReached && !turnBudgetBlocks) {
          return undefined;
        }
        const reason = goalBudgetBlockReason(budget) ?? GOAL_BUDGET_BLOCK_PREFIX;
        if (!effects.budgetGraceTurns.has(turnId)) {
          effects.budgetGraceTurns.add(turnId);
          return undefined;
        }
        return { type: 'done', cause: { reason: 'goal_budget', message: reason } };
      };

      const turnStarted = (turnId: number): void => {
        effects.liveTurnId = turnId;
        effects.goalDrivenTurns.delete(turnId);
        effects.goalTurnTargets.delete(turnId);
        effects.budgetGraceTurns.delete(turnId);
        effects.budgetStopInjectedTurns.delete(turnId);
      };

      const bindContinuationEntry = (turnId: number, entry: HistoryMessage): void => {
        const pending = effects.pendingContinuation;
        if (pending === undefined || pending.turnId !== undefined) return;
        if (entry.message.role !== 'user') return;
        if ((entry as UserEntry).meta?.promptId === pending.promptId) pending.turnId = turnId;
      };

      const classifyTurn = (turnId: number, entry: HistoryMessage): void => {
        if (!storeReady || effects.classifiedTurns.has(turnId)) return;
        effects.classifiedTurns.add(turnId);
        const userEntry = entry.message.role === 'user' ? (entry as UserEntry) : undefined;
        const pending = effects.pendingContinuation;
        if (effects.goalDrivenTurns.has(turnId)) return;
        const goal = current();
        const continuationGoalId =
          pending?.turnId === turnId || isGoalContinuationOrigin(userEntry?.meta?.origin)
            ? pending?.goalId
            : undefined;
        if (continuationGoalId !== undefined && goal?.goalId !== continuationGoalId) {
          effects.goalDrivenTurns.set(turnId, continuationGoalId);
        } else if (goal?.status === 'active') {
          const reason = goalBudgetBlockReason(toSnapshot(goal).budget);
          if (reason === undefined) {
            effects.goalDrivenTurns.set(turnId, goal.goalId);
          } else {
            enqueue(() => applyBudgetBlock(goal, reason));
          }
        }
      };

      const turnDone = (turnId: number, outcome: TurnOutcome): void => {
        const tracked = clearTurnTracking(turnId);
        const resumeContinuation = effects.resumeContinuation;
        if (resumeContinuation?.turnId === turnId) effects.resumeContinuation = undefined;
        void run(async () => {
          if (resumeContinuation?.turnId === turnId && outcome.type === 'aborted') {
            const goal = current();
            if (
              goal === null ||
              goal.status !== 'active' ||
              goal.goalId !== resumeContinuation.goalId
            ) {
              return;
            }
            if ((await blockIfBudgetReached(goal)) !== null) return;
            launchContinuationTurn(resumeContinuation.goalId);
            return;
          }
          const { goalId, lifecycleGoalId, starterTurn, outcomeGoalId } = tracked;
          if (goalId === undefined || lifecycleGoalId === undefined) return;
          if (outcome.type === 'done' && outcomeGoalId === lifecycleGoalId) {
            agent.loop.notify(createUserEntry({ role: 'user', content: [] }, { source: 'notify' }));
            return;
          }
          const stepCapped = outcome.type === 'blocked' && outcome.cause.reason === MAX_STEPS_REASON;
          if (!stepCapped && (outcome.type === 'aborted' || outcome.type === 'failed')) {
            await settleAbnormalTurn(outcome, lifecycleGoalId);
            return;
          }
          if (!stepCapped && outcome.type === 'blocked') {
            await settleHookBlockedTurn(outcome.cause, lifecycleGoalId);
            return;
          }
          if (starterTurn) await incrementGoalTurn(goalId);
          const goal = current();
          if (goal === null || goal.status !== 'active' || goal.goalId !== lifecycleGoalId) return;
          if ((await blockIfBudgetReached(goal)) !== null) return;
          launchContinuationTurn(lifecycleGoalId, stepCapped);
        }).catch((error: unknown) => {
          enqueue(() => settleGoalAfterContinuationFailure(error, tracked.lifecycleGoalId));
        });
      };

      const messageAppended = (event: {
        readonly turnId: number;
        readonly source: string;
        readonly entry: HistoryMessage;
      }): void => {
        bindContinuationEntry(event.turnId, event.entry);
        classifyTurn(event.turnId, event.entry);
        if (event.source !== 'llm' || event.entry.message.role !== 'assistant') return;
        const goalId = effects.goalDrivenTurns.get(event.turnId);
        if (goalId === undefined) return;
        const output = (event.entry as AssistantEntry).meta?.usage?.output ?? 0;
        enqueue(() => accountTokenUsage(output, goalId));
      };

      const normalize = (): Promise<void> =>
        run(async () => {
          clearDeadlineTimer();
          effects.liveWallClockStartedAt = undefined;
          const goal = current();
          if (goal === null) return;
          if (goal.status === 'complete') {
            await clearInternal({ emit: false });
            return;
          }
          if (goal.status !== 'active') return;
          await store.dispatch([
            {
              type: GOAL_UPDATE,
              status: 'paused',
              reason: 'Paused after agent resume',
              wallClockMs: goal.wallClockMs,
              actor: 'runtime',
            },
          ]);
        });

      const close = (): Promise<void> =>
        run(async () => {
          const goal = current();
          if (goal === null || goal.status !== 'active') return;
          await applyLifecycle(goal, 'paused', 'Paused after agent closed', 'runtime');
        });

      const face: GoalFace = {
        state,
        getGoal,
        createGoal: createGoalFace,
        pauseGoal,
        resumeGoal,
        setBudgetLimits,
        cancelGoal,
        markBlocked,
        markComplete,
        pauseOnInterrupt,
      };
      const trackOutcomeToolResult = (snapshot: GoalSnapshot | null): GoalSnapshot | null => {
        const turnId = effects.liveTurnId;
        if (snapshot !== null && turnId !== undefined) {
          effects.goalOutcomeToolResultTurns.set(turnId, snapshot.goalId);
        }
        return snapshot;
      };
      useAgentTools(
        createCreateGoalTool({ createGoal: createGoalFace }, agent.id),
        createGetGoalTool({ getGoal }, agent.id),
        createUpdateGoalTool(
          {
            getGoal,
            resumeGoal,
            markComplete: async (input, actor) => trackOutcomeToolResult(await markComplete(input, actor)),
            markBlocked: async (input, actor) => trackOutcomeToolResult(await markBlocked(input, actor)),
          },
          agent.id,
        ),
        createSetGoalBudgetTool({ getGoal, setBudgetLimits }, agent.id),
      );
      if (agent.id !== MAIN_AGENT_ID) {
        useExpose(GoalRef, face);
        return;
      }
      const interactions = useInteractions().value;
      if (interactions === undefined) {
        throw new Error('goal feature requires the interaction feature');
      }
      useToolPermitting(
        createGoalGuard({
          turnTarget: goalTurnTarget,
          getGoal,
          inBudgetGraceTurn: (turnId) => effects.budgetGraceTurns.has(turnId),
          interactions,
          sessionId: useSession().id,
          agentId: agent.id,
        }),
        { id: 'goal.guard' },
      );
      useStepStarting(({ turnId, messages }) => stepStarted(turnId, messages), {
        id: 'goal.step-starting',
      });
      useStepContinuing(({ turnId }) => budgetStepContinuing(turnId), { id: 'goal.budget' });
      useLoopEvent('turn.started', ({ turnId }) => {
        turnStarted(turnId);
      });
      useLoopEvent('turn.resumed', ({ turnId }) => {
        effects.liveTurnId = turnId;
      });
      useLoopEvent('turn.ended', ({ turnId, outcome }) => {
        turnDone(turnId, outcome);
      });
      useLoopEvent('message.appended', messageAppended);
      useCleanup(clearDeadlineTimer);
      useCleanup(() => close());
      useReady(
        (async () => {
          await store.ready;
          storeReady = true;
          await normalize();
        })(),
      );
      useExpose(GoalRef, face);
    },
  });
}

function pauseReasonWithMessage(prefix: string, message: string | undefined): string {
  const trimmed = message?.trim();
  return trimmed === undefined || trimmed.length === 0 ? prefix : `${prefix}: ${trimmed}`;
}

function goalFailurePauseReason(error: unknown): string {
  const payload = llmErrorPayloadOf(error);
  switch (payload?.kind) {
    case 'rate_limit':
      return GOAL_RATE_LIMIT_PAUSE_REASON;
    case 'connection':
    case 'timeout':
      return pauseReasonWithMessage(GOAL_PROVIDER_CONNECTION_PAUSE_PREFIX, payload.message);
    case 'status':
    case 'auth':
    case 'provider':
    case 'overloaded':
    case 'quota_exhausted':
    case 'context_overflow':
    case 'request_too_large':
    case 'request_structure':
    case 'image_format':
      return pauseReasonWithMessage(GOAL_PROVIDER_API_PAUSE_PREFIX, payload.message);
    default:
      return pauseReasonWithMessage(
        GOAL_RUNTIME_PAUSE_PREFIX,
        payload?.message ?? (error instanceof Error ? error.message : String(error)),
      );
  }
}

function llmErrorPayloadOf(error: unknown): { readonly kind: string; readonly message: string } | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { readonly kind?: unknown; readonly message?: unknown };
  if (typeof record.kind !== 'string' || typeof record.message !== 'string') return undefined;
  return { kind: record.kind, message: record.message };
}

function normalizeCompletionCriterion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed?.length) return undefined;
  return trimmed.length > MAX_GOAL_COMPLETION_CRITERION_LENGTH
    ? trimmed.slice(0, MAX_GOAL_COMPLETION_CRITERION_LENGTH)
    : trimmed;
}
