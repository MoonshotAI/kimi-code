import { type Event } from '#/_base/event';
import { setup } from 'xstate';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { LoopControlToken } from './internal/loop';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import { AgentLoopLogic } from './internal/loopLogic';
import { registerLoopControl, type LoopDurableState } from './internal/access';
import { TurnCancel, TurnEnded, TurnPrompt, TurnSteer } from '#/features/loop/turnOps';
import { AgentLoop, type LoopRuntime } from './loop';
import type { LoopResult, LoopStatus, TurnEndedEvent, TurnStartedEvent } from './loop';

class AgentLoopRuntime implements LoopRuntime {
  private readonly loop: AgentLoopLogic;
  private lastResult: LoopResult = { status: 'idle' };

  constructor(private readonly context: AgentRuntimeContext<LoopDurableState>) {
    this.loop = context.get(LoopControlToken) as unknown as AgentLoopLogic;
    registerLoopControl(context.agent, this.loop, () => context.getState());
    this.loop.onDidEndTurn(({ result }) => {
      this.lastResult = { status: result.type === 'completed' ? 'settled' : result.type === 'cancelled' ? 'cancelled' : 'idle' };
    });
  }

  get onDidStartTurn(): Event<TurnStartedEvent> {
    return (listener) => this.loop.onDidStartTurn((turnId) => listener({ turnId }));
  }

  get onDidEndTurn(): Event<TurnEndedEvent> {
    return (listener) => this.loop.onDidEndTurn(({ turnId, result }) => listener({
      turnId,
      status: result.type === 'completed' ? 'settled' : result.type === 'cancelled' ? 'cancelled' : 'idle',
    }));
  }

  async run(_input: { readonly promptId?: string }): Promise<LoopResult> {
    let turnId = this.loop.status().activeTurnId;
    if (turnId === undefined) {
      const pending = this.loop.status().pendingTurnIds[0];
      if (pending === undefined) return this.lastResult;
      turnId = await new Promise<number>((resolve) => {
        const disposable = this.loop.onDidStartTurn((started) => {
          if (started === pending) {
            disposable.dispose();
            resolve(started);
          }
        });
      });
    }
    const result = await this.loop.run({ turnId });
    this.lastResult = { status: result.type === 'completed' ? 'settled' : result.type === 'cancelled' ? 'cancelled' : 'idle' };
    return this.lastResult;
  }

  async cancel(reason?: string): Promise<void> {
    this.loop.cancel(undefined, reason);
  }

  async cancelByUser(reason?: string): Promise<void> {
    this.loop.cancelFromUser();
    if (reason !== undefined) this.loop.cancel(undefined, reason);
  }

  status(): LoopStatus {
    if (this.loop.status().state === 'running') return 'running';
    return this.lastResult.status;
  }

  async waitUntilSettled(): Promise<LoopResult> {
    await this.loop.settled();
    return this.lastResult;
  }
}

interface LoopActorContext {
  readonly runtime: AgentRuntimeContext<unknown>;
  state: LoopDurableState;
}

interface LoopCommitEvent {
  readonly type: 'loop.commit';
  readonly state: LoopDurableState;
}

const loopActorLogic = setup({
  types: {} as {
    context: LoopActorContext;
    input: AgentRuntimeContext<unknown>;
    events: AgentRuntimeRestoreEvent | LoopCommitEvent;
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    state: { nextTurnId: 0, cancelledTurnIds: [] },
  }),
  on: {
    'loop.commit': {
      actions: ({ context, event }) => {
        context.state = event.state;
      },
    },
  },
});

function loopTransition(state: LoopDurableState, event: unknown): LoopDurableState | undefined {
  if (event instanceof TurnPrompt) return { ...state, nextTurnId: state.nextTurnId + 1 };
  if (event instanceof TurnSteer) return state;
  if (event instanceof TurnCancel) {
    if (event.target === undefined || event.turnId === undefined || event.turnId < state.nextTurnId) return state;
    const cancelled = [...new Set([...state.cancelledTurnIds, event.turnId])].toSorted((a, b) => a - b);
    let nextTurnId = state.nextTurnId;
    while (cancelled.includes(nextTurnId)) nextTurnId += 1;
    return { ...state, nextTurnId, cancelledTurnIds: cancelled.filter((id) => id >= nextTurnId) };
  }
  if (event instanceof TurnEnded) {
    return { ...state, lastEnded: { turnId: event.turnId, reason: event.reason, durationMs: event.durationMs } };
  }
  return;
}

export const loopAgentRuntimeProvider = defineAgentRuntimeProvider<LoopDurableState, LoopRuntime>(AgentLoop, {
  id: 'loop',
  logic: loopActorLogic,
  eager: true,
  durable: {
    events: [TurnPrompt, TurnSteer, TurnCancel, TurnEnded],
    undoable: false,
    transition: loopTransition,
    read: (snapshot) => (snapshot as unknown as { context: LoopActorContext }).context.state,
    commit: (actor, state) => {
      actor.send({ type: 'loop.commit', state });
    },
  },
  createApi: (context) => new AgentLoopRuntime(context),
});

registerScopedService(
  LifecycleScope.Agent,
  LoopControlToken,
  AgentLoopLogic,
  ScopeActivation.OnScopeCreated,
  'loop-control',
);
