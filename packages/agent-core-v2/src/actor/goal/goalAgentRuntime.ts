import { ContextAppendMessage } from '#/actor/contextMemory/contextEvents';
import type { ContextMessage } from '#/actor/contextMemory/types';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/actor/agentRuntime';

import type { GoalReasonInput, ResumeGoalInput } from './goal';
import {
  GoalClear,
  GoalCreate,
  GoalForked,
  GoalUpdate,
  type GoalModelState,
} from './goalOps';
import type {
  CreateGoalInput,
  GoalActor,
  GoalBudgetLimits,
  GoalSnapshot,
  GoalToolResult,
} from './types';
import { goalActorLogic, type GoalActorSnapshot } from './internal/goalMachine';
import {
  GOAL_FORK_CLEARED_REMINDER_NAME,
  cancelGoal,
  createGoal,
  getGoal,
  incrementTurn,
  isGoalToolTarget,
  markBlocked,
  markComplete,
  pauseGoal,
  pauseOnInterrupt,
  recordTokenUsage,
  resumeGoal,
  setBudgetLimits,
} from './internal/goalOperations';

export interface GoalForkNoticeState {
  readonly goalPresent: boolean;
  readonly reminderPending: boolean;
}

export interface GoalRuntimeState {
  readonly goal: GoalModelState;
  readonly forkNotice: GoalForkNoticeState;
}

function isGoalForkClearedReminder(message: ContextMessage | undefined): boolean {
  const origin = message?.origin;
  if (origin?.kind === 'injection') return origin.variant === GOAL_FORK_CLEARED_REMINDER_NAME;
  return origin?.kind === 'system_trigger' && origin.name === GOAL_FORK_CLEARED_REMINDER_NAME;
}

export class GoalRuntime {
  constructor(private readonly runtime: AgentRuntimeContext<GoalRuntimeState>) {}

  getGoal(): GoalToolResult {
    return getGoal(this.runtime);
  }

  isGoalToolTarget(turnId: number, goalId: string): boolean {
    return isGoalToolTarget(this.runtime, turnId, goalId);
  }

  async createGoal(input: CreateGoalInput, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return createGoal(this.runtime, input, actor);
  }

  async pauseGoal(input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return pauseGoal(this.runtime, input, actor);
  }

  async resumeGoal(input: ResumeGoalInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return resumeGoal(this.runtime, input, actor);
  }

  async setBudgetLimits(
    input: { readonly budgetLimits: GoalBudgetLimits },
    actor: GoalActor = 'user',
  ): Promise<GoalSnapshot> {
    return setBudgetLimits(this.runtime, input, actor);
  }

  async cancelGoal(_input: GoalReasonInput = {}, actor: GoalActor = 'user'): Promise<GoalSnapshot> {
    return cancelGoal(this.runtime, _input, actor);
  }

  async markBlocked(
    input: GoalReasonInput = {},
    actor: GoalActor = 'runtime',
  ): Promise<GoalSnapshot | null> {
    return markBlocked(this.runtime, input, actor);
  }

  async markComplete(
    input: GoalReasonInput = {},
    actor: GoalActor = 'model',
  ): Promise<GoalSnapshot | null> {
    return markComplete(this.runtime, input, actor);
  }

  async pauseOnInterrupt(input: GoalReasonInput = {}): Promise<GoalSnapshot | null> {
    return pauseOnInterrupt(this.runtime, input);
  }

  async recordTokenUsage(tokenDelta: number): Promise<GoalSnapshot | null> {
    return recordTokenUsage(this.runtime, tokenDelta);
  }

  async incrementTurn(): Promise<GoalSnapshot | null> {
    return incrementTurn(this.runtime);
  }
}

export const AgentGoal = defineAgentRuntimeContract<GoalRuntime>('goal');

export const goalAgentRuntimeProvider = defineAgentRuntimeProvider<GoalRuntimeState, GoalRuntime>(AgentGoal, {
  id: 'goal',
  logic: goalActorLogic,
  eager: true,
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
  createApi: (context) => new GoalRuntime(context),
  inspect: (snapshot) => {
    const goal = (snapshot as GoalActorSnapshot).context.durable.goal;
    if (goal === null) return null;
    return {
      goalId: goal.goalId,
      objective: goal.objective,
      status: goal.status,
      turnsUsed: goal.turnsUsed,
      tokensUsed: goal.tokensUsed,
      wallClockMs: goal.wallClockMs,
      budgetLimits: goal.budgetLimits,
      terminalReason: goal.terminalReason,
    };
  },
});
