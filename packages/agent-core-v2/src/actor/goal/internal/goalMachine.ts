import { assign, enqueueActions, fromCallback, sendTo, setup, type Snapshot } from 'xstate';

import { MutableDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { AgentRuntimeContext, AgentRuntimeRestoreEvent } from '#/actor/agentRuntime';
import { getLoopControl } from '#/actor/loop/internal/access';
import type { EnqueueReceipt } from '#/actor/loop/internal/loop';
import { TurnStarted } from '#/actor/loop/turnEvents';
import { TurnEnded } from '#/actor/loop/turnOps';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import { AgentUsage } from '#/actor/usage/usageAgentRuntime';
import { IAgentLifecycleService, MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import { GoalInjection } from '../injection/goalInjection';

import { IGoalDeadlineScheduler } from '../goalDeadlineScheduler';
import type { GoalRuntimeState } from '../goalAgentRuntime';
import {
  getGoal,
  handleAfterStep,
  handleBeforeStep,
  handleGoalStartApproval,
  handleGoalToolVeto,
  handleToolCompleted,
  handleTurnEndedEvent,
  handleTurnLaunched,
  handleUsageRecorded,
  handleWallClockDeadline,
  isWaitForAvailable,
  normalizeAfterReplay,
  reminderOf,
  wallClockDeadlineDelay,
} from './goalOperations';

export type GoalRuntimeContext = AgentRuntimeContext<GoalRuntimeState>;

export interface PendingContinuation {
  readonly receipt: EnqueueReceipt;
  readonly goalId: string;
  turnId?: number;
}

export interface ResumeContinuation {
  readonly turnId: number;
  readonly goalId: string;
}

export interface GoalMachineContext {
  readonly runtime: GoalRuntimeContext;
  durable: GoalRuntimeState;
  liveTurnId: number | undefined;
  liveWallClockStartedAt: number | undefined;
  pendingContinuation: PendingContinuation | undefined;
  resumeContinuation: ResumeContinuation | undefined;
  goalDrivenTurns: ReadonlyMap<number, string>;
  countedGoalTurns: ReadonlySet<number>;
  goalStarterTurns: ReadonlySet<number>;
  goalOutcomeToolResultTurns: ReadonlyMap<number, string>;
  goalOutcomeContinuationTurns: ReadonlySet<number>;
  budgetGraceTurns: ReadonlySet<number>;
  pendingContinuationGoals: ReadonlyMap<number, string>;
  goalTurnTargets: ReadonlyMap<number, string>;
  exhaustedTurnBudgetGoals: ReadonlyMap<number, string>;
}

export type GoalActorSnapshot = Snapshot<unknown> & {
  readonly context: GoalMachineContext;
};

export interface GoalCommitEvent {
  readonly type: 'goal.commit';
  readonly durable: GoalRuntimeState;
}

export interface GoalTurnLaunchedEvent {
  readonly type: 'goal.turnLaunched';
  readonly turnId: number;
}

export interface GoalTurnDriveResolvedEvent {
  readonly type: 'goal.turnDriveResolved';
  readonly turnId: number;
  readonly drivenGoalId?: string;
}

export interface GoalStarterTurnAdoptedEvent {
  readonly type: 'goal.starterTurnAdopted';
  readonly turnId: number;
  readonly goalId: string;
  readonly toolTarget: boolean;
  readonly turnBudgetExhausted: boolean;
  readonly adopt: boolean;
}

export interface GoalTurnCountedEvent {
  readonly type: 'goal.turnCounted';
  readonly turnId: number;
}

export interface GoalGraceGrantedEvent {
  readonly type: 'goal.graceGranted';
  readonly turnId: number;
}

export interface GoalOutcomeToolResultEvent {
  readonly type: 'goal.outcomeToolResult';
  readonly turnId: number;
  readonly goalId: string;
}

export interface GoalOutcomeConsumedEvent {
  readonly type: 'goal.outcomeConsumed';
  readonly turnId: number;
  readonly recordContinuation: boolean;
}

export interface GoalTurnEndedEvent {
  readonly type: 'goal.turnEnded';
  readonly turnId: number;
}

export interface GoalContinuationPendingEvent {
  readonly type: 'goal.continuationPending';
  readonly pending: PendingContinuation;
}

export interface GoalContinuationAssignedEvent {
  readonly type: 'goal.continuationAssigned';
  readonly pending: PendingContinuation;
  readonly turnId: number;
}

export interface GoalContinuationSettledEvent {
  readonly type: 'goal.continuationSettled';
  readonly pending: PendingContinuation;
}

export interface GoalPursuitStoppedEvent {
  readonly type: 'goal.pursuitStopped';
  readonly clearPendingContinuation: boolean;
}

export interface GoalResumeScheduledEvent {
  readonly type: 'goal.resumeScheduled';
  readonly turnId: number;
  readonly goalId: string;
}

export interface GoalWallClockStartedEvent {
  readonly type: 'goal.wallClockStarted';
  readonly at: number;
}

export interface GoalDeadlineRefreshEvent {
  readonly type: 'goal.deadline.refresh';
}

export type GoalMachineEvent =
  | GoalCommitEvent
  | GoalTurnLaunchedEvent
  | GoalTurnDriveResolvedEvent
  | GoalStarterTurnAdoptedEvent
  | GoalTurnCountedEvent
  | GoalGraceGrantedEvent
  | GoalOutcomeToolResultEvent
  | GoalOutcomeConsumedEvent
  | GoalTurnEndedEvent
  | GoalContinuationPendingEvent
  | GoalContinuationAssignedEvent
  | GoalContinuationSettledEvent
  | GoalPursuitStoppedEvent
  | GoalResumeScheduledEvent
  | GoalWallClockStartedEvent
  | GoalDeadlineRefreshEvent
  | AgentRuntimeRestoreEvent;

type GoalNode = 'noGoal' | 'active' | 'paused' | 'blocked';

function mapWith<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function mapWithout<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function setWith<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

function setWithout<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

function commitNodeOf(event: GoalCommitEvent): GoalNode {
  const goal = event.durable.goal;
  if (goal === null || goal.status === 'complete') return 'noGoal';
  return goal.status;
}

interface GoalEffectsInput {
  readonly runtime: GoalRuntimeContext;
  readonly restore: AgentRuntimeRestoreEvent;
}

const goalEffects = fromCallback(({ input }: { input: GoalEffectsInput }) => {
  const runtime = input.runtime;
  const disposables: IDisposable[] = [];
  if (runtime.agent.agentId === MAIN_AGENT_ID) {
    disposables.push(
      new GoalInjection(
        {
          getGoal: () => getGoal(runtime).goal,
          isWaitForEnabled: () => isWaitForAvailable(runtime),
        },
        reminderOf(runtime),
      ),
    );
    const eventBus = runtime.get(IAgentHostService).of(runtime.agent).eventBus;
    disposables.push(
      eventBus.subscribe(TurnStarted, (event) => {
        handleTurnLaunched(runtime, event.turnId, event.origin);
      }),
    );
    disposables.push(
      runtime
        .get(IAgentLifecycleService)
        .resolve(runtime.agent, AgentUsage)
        .onDidRecord((usage) => {
          handleUsageRecorded(runtime, usage);
        }),
    );
    const loop = getLoopControl(runtime.agent);
    disposables.push(
      loop.hooks.onWillBeginStep.register('goal-count-turn', async (context, next) => {
        await handleBeforeStep(runtime, context);
        await next();
      }),
    );
    disposables.push(
      loop.hooks.onDidFinishStep.register('goal-outcome-continuation', async (context, next) => {
        handleAfterStep(runtime, context);
        await next();
      }),
    );
    const tools = runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentTools);
    disposables.push(
      tools.participateExecution('goal-approval', (event) => {
        handleGoalStartApproval(runtime, event);
      }),
    );
    disposables.push(
      tools.participateExecution('goal-veto', (event) => {
        handleGoalToolVeto(runtime, event);
      }),
    );
    disposables.push(
      tools.registerDidExecuteHook('goal-outcome-tool-result', async (context, next) => {
        handleToolCompleted(runtime, context);
        await next();
      }),
    );
    disposables.push(
      eventBus.subscribe(TurnEnded, (event) => {
        handleTurnEndedEvent(runtime, event);
      }),
    );
    normalizeAfterReplay(runtime);
  }
  input.restore.waitUntil(Promise.resolve());
  return () => {
    for (let index = disposables.length - 1; index >= 0; index -= 1) {
      disposables[index]!.dispose();
    }
  };
});

const goalDeadline = fromCallback(
  ({
    input,
    receive,
  }: {
    input: GoalRuntimeContext;
    receive: (listener: (event: GoalDeadlineRefreshEvent) => void) => void;
  }) => {
    const scheduler = input.get(IGoalDeadlineScheduler);
    const timer = new MutableDisposable<IDisposable>();
    receive((event) => {
      timer.clear();
      if (event.type !== 'goal.deadline.refresh') return;
      const delay = wallClockDeadlineDelay(input);
      if (delay !== undefined) {
        timer.value = scheduler.schedule(delay, () => {
          handleWallClockDeadline(input);
        });
      }
    });
    return () => {
      timer.dispose();
    };
  },
);

export const goalActorLogic = setup({
  types: {} as {
    context: GoalMachineContext;
    input: GoalRuntimeContext;
    events: GoalMachineEvent;
  },
  actors: { goalEffects, goalDeadline },
  actions: {
    applyCommit: assign({
      durable: ({ event }) => (event as GoalCommitEvent).durable,
    }),
    applyTurnLaunched: assign(({ context, event }) => {
      const e = event as GoalTurnLaunchedEvent;
      return {
        liveTurnId: e.turnId,
        goalTurnTargets: mapWithout(context.goalTurnTargets, e.turnId),
        exhaustedTurnBudgetGoals: mapWithout(context.exhaustedTurnBudgetGoals, e.turnId),
      };
    }),
    applyTurnDriveResolved: assign(({ context, event }) => {
      const e = event as GoalTurnDriveResolvedEvent;
      return {
        goalDrivenTurns:
          e.drivenGoalId === undefined
            ? context.goalDrivenTurns
            : mapWith(context.goalDrivenTurns, e.turnId, e.drivenGoalId),
        pendingContinuationGoals: mapWithout(context.pendingContinuationGoals, e.turnId),
        goalOutcomeToolResultTurns: mapWithout(context.goalOutcomeToolResultTurns, e.turnId),
        goalOutcomeContinuationTurns: setWithout(context.goalOutcomeContinuationTurns, e.turnId),
      };
    }),
    applyStarterTurnAdopted: assign(({ context, event }) => {
      const e = event as GoalStarterTurnAdoptedEvent;
      return {
        goalTurnTargets: e.toolTarget
          ? mapWith(context.goalTurnTargets, e.turnId, e.goalId)
          : context.goalTurnTargets,
        exhaustedTurnBudgetGoals: e.turnBudgetExhausted
          ? mapWith(context.exhaustedTurnBudgetGoals, e.turnId, e.goalId)
          : mapWithout(context.exhaustedTurnBudgetGoals, e.turnId),
        goalDrivenTurns: e.adopt
          ? mapWith(context.goalDrivenTurns, e.turnId, e.goalId)
          : context.goalDrivenTurns,
        countedGoalTurns: e.adopt
          ? setWith(context.countedGoalTurns, e.turnId)
          : context.countedGoalTurns,
        goalStarterTurns: e.adopt
          ? setWith(context.goalStarterTurns, e.turnId)
          : context.goalStarterTurns,
      };
    }),
    applyTurnCounted: assign({
      countedGoalTurns: ({ context, event }) =>
        setWith(context.countedGoalTurns, (event as GoalTurnCountedEvent).turnId),
    }),
    applyGraceGranted: assign({
      budgetGraceTurns: ({ context, event }) =>
        setWith(context.budgetGraceTurns, (event as GoalGraceGrantedEvent).turnId),
    }),
    applyOutcomeToolResult: assign({
      goalOutcomeToolResultTurns: ({ context, event }) => {
        const e = event as GoalOutcomeToolResultEvent;
        return mapWith(context.goalOutcomeToolResultTurns, e.turnId, e.goalId);
      },
    }),
    applyOutcomeConsumed: assign(({ context, event }) => {
      const e = event as GoalOutcomeConsumedEvent;
      return {
        goalOutcomeToolResultTurns: mapWithout(context.goalOutcomeToolResultTurns, e.turnId),
        goalOutcomeContinuationTurns: e.recordContinuation
          ? setWith(context.goalOutcomeContinuationTurns, e.turnId)
          : context.goalOutcomeContinuationTurns,
      };
    }),
    applyTurnEnded: assign(({ context, event }) => {
      const e = event as GoalTurnEndedEvent;
      return {
        pendingContinuation:
          context.pendingContinuation?.turnId === e.turnId ? undefined : context.pendingContinuation,
        liveTurnId: context.liveTurnId === e.turnId ? undefined : context.liveTurnId,
        resumeContinuation:
          context.resumeContinuation?.turnId === e.turnId ? undefined : context.resumeContinuation,
        goalDrivenTurns: mapWithout(context.goalDrivenTurns, e.turnId),
        countedGoalTurns: setWithout(context.countedGoalTurns, e.turnId),
        goalStarterTurns: setWithout(context.goalStarterTurns, e.turnId),
        goalOutcomeToolResultTurns: mapWithout(context.goalOutcomeToolResultTurns, e.turnId),
        goalOutcomeContinuationTurns: setWithout(context.goalOutcomeContinuationTurns, e.turnId),
        budgetGraceTurns: setWithout(context.budgetGraceTurns, e.turnId),
        pendingContinuationGoals: mapWithout(context.pendingContinuationGoals, e.turnId),
        goalTurnTargets: mapWithout(context.goalTurnTargets, e.turnId),
        exhaustedTurnBudgetGoals: mapWithout(context.exhaustedTurnBudgetGoals, e.turnId),
      };
    }),
    applyContinuationPending: assign({
      pendingContinuation: ({ event }) => (event as GoalContinuationPendingEvent).pending,
    }),
    applyContinuationAssigned: enqueueActions(({ context, event, enqueue }) => {
      const e = event as GoalContinuationAssignedEvent;
      e.pending.turnId = e.turnId;
      if (!context.goalDrivenTurns.has(e.turnId)) {
        enqueue.assign({
          pendingContinuationGoals: mapWith(
            context.pendingContinuationGoals,
            e.turnId,
            e.pending.goalId,
          ),
        });
      }
    }),
    applyContinuationSettled: assign(({ context, event }) => {
      const e = event as GoalContinuationSettledEvent;
      return {
        pendingContinuationGoals:
          e.pending.turnId === undefined
            ? context.pendingContinuationGoals
            : mapWithout(context.pendingContinuationGoals, e.pending.turnId),
        pendingContinuation:
          context.pendingContinuation === e.pending ? undefined : context.pendingContinuation,
      };
    }),
    applyPursuitStopped: assign(({ context, event }) => {
      const e = event as GoalPursuitStoppedEvent;
      return {
        resumeContinuation: undefined,
        liveWallClockStartedAt: undefined,
        pendingContinuation: e.clearPendingContinuation ? undefined : context.pendingContinuation,
      };
    }),
    applyResumeScheduled: assign({
      resumeContinuation: ({ event }) => {
        const e = event as GoalResumeScheduledEvent;
        return { turnId: e.turnId, goalId: e.goalId };
      },
    }),
    applyWallClockStarted: assign({
      liveWallClockStartedAt: ({ event }) => (event as GoalWallClockStartedEvent).at,
    }),
  },
  guards: {
    restoredActive: ({ context }) => context.durable.goal?.status === 'active',
    restoredPaused: ({ context }) => context.durable.goal?.status === 'paused',
    restoredBlocked: ({ context }) => context.durable.goal?.status === 'blocked',
    commitActive: ({ event }) => commitNodeOf(event as GoalCommitEvent) === 'active',
    commitPaused: ({ event }) => commitNodeOf(event as GoalCommitEvent) === 'paused',
    commitBlocked: ({ event }) => commitNodeOf(event as GoalCommitEvent) === 'blocked',
    commitNoGoal: ({ event }) => commitNodeOf(event as GoalCommitEvent) === 'noGoal',
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    durable: {
      goal: null,
      forkNotice: { goalPresent: false, reminderPending: false },
    },
    liveTurnId: undefined,
    liveWallClockStartedAt: undefined,
    pendingContinuation: undefined,
    resumeContinuation: undefined,
    goalDrivenTurns: new Map(),
    countedGoalTurns: new Set(),
    goalStarterTurns: new Set(),
    goalOutcomeToolResultTurns: new Map(),
    goalOutcomeContinuationTurns: new Set(),
    budgetGraceTurns: new Set(),
    pendingContinuationGoals: new Map(),
    goalTurnTargets: new Map(),
    exhaustedTurnBudgetGoals: new Map(),
  }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: {
        'runtime.restore': [
          { target: 'restored.active', guard: 'restoredActive' },
          { target: 'restored.paused', guard: 'restoredPaused' },
          { target: 'restored.blocked', guard: 'restoredBlocked' },
          { target: 'restored.noGoal' },
        ],
      },
    },
    restored: {
      invoke: {
        id: 'goalEffects',
        src: 'goalEffects',
        input: ({ context, event }): GoalEffectsInput => ({
          runtime: context.runtime,
          restore: event as AgentRuntimeRestoreEvent,
        }),
      },
      initial: 'noGoal',
      states: {
        noGoal: {
          on: {
            'goal.commit': [
              { guard: 'commitActive', target: 'active', actions: 'applyCommit' },
              { guard: 'commitPaused', target: 'paused', actions: 'applyCommit' },
              { guard: 'commitBlocked', target: 'blocked', actions: 'applyCommit' },
              { actions: 'applyCommit' },
            ],
          },
        },
        active: {
          invoke: {
            id: 'goalDeadline',
            src: 'goalDeadline',
            input: ({ context }) => context.runtime,
          },
          on: {
            'goal.deadline.refresh': {
              actions: sendTo('goalDeadline', ({ event }) => event),
            },
            'goal.commit': [
              { guard: 'commitPaused', target: 'paused', actions: 'applyCommit' },
              { guard: 'commitBlocked', target: 'blocked', actions: 'applyCommit' },
              { guard: 'commitNoGoal', target: 'noGoal', actions: 'applyCommit' },
              { actions: 'applyCommit' },
            ],
          },
        },
        paused: {
          on: {
            'goal.commit': [
              { guard: 'commitActive', target: 'active', actions: 'applyCommit' },
              { guard: 'commitBlocked', target: 'blocked', actions: 'applyCommit' },
              { guard: 'commitNoGoal', target: 'noGoal', actions: 'applyCommit' },
              { actions: 'applyCommit' },
            ],
          },
        },
        blocked: {
          on: {
            'goal.commit': [
              { guard: 'commitActive', target: 'active', actions: 'applyCommit' },
              { guard: 'commitPaused', target: 'paused', actions: 'applyCommit' },
              { guard: 'commitNoGoal', target: 'noGoal', actions: 'applyCommit' },
              { actions: 'applyCommit' },
            ],
          },
        },
      },
    },
  },
  on: {
    'goal.commit': { actions: 'applyCommit' },
    'goal.turnLaunched': { actions: 'applyTurnLaunched' },
    'goal.turnDriveResolved': { actions: 'applyTurnDriveResolved' },
    'goal.starterTurnAdopted': { actions: 'applyStarterTurnAdopted' },
    'goal.turnCounted': { actions: 'applyTurnCounted' },
    'goal.graceGranted': { actions: 'applyGraceGranted' },
    'goal.outcomeToolResult': { actions: 'applyOutcomeToolResult' },
    'goal.outcomeConsumed': { actions: 'applyOutcomeConsumed' },
    'goal.turnEnded': { actions: 'applyTurnEnded' },
    'goal.continuationPending': { actions: 'applyContinuationPending' },
    'goal.continuationAssigned': { actions: 'applyContinuationAssigned' },
    'goal.continuationSettled': { actions: 'applyContinuationSettled' },
    'goal.pursuitStopped': { actions: 'applyPursuitStopped' },
    'goal.resumeScheduled': { actions: 'applyResumeScheduled' },
    'goal.wallClockStarted': { actions: 'applyWallClockStarted' },
  },
});
