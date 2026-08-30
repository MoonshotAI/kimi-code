import { type Event } from '#/_base/event';
import {
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
} from '#/actor/agentRuntime';
import { loopActorLogic, type LoopMachineContext } from './internal/loopLogic';
import { getLoopControl, type LoopDurableState } from './internal/access';
import type { LoopControl } from './internal/loop';
import { TurnCancel, TurnEnded, TurnPrompt, TurnSteer } from '#/actor/loop/turnOps';
import { AgentLoop, type LoopRuntime } from './loop';
import type { LoopResult, LoopStatus, TurnEndedEvent, TurnStartedEvent } from './loop';

class AgentLoopRuntime implements LoopRuntime {
  private readonly control: LoopControl;

  constructor(private readonly context: AgentRuntimeContext<LoopDurableState>) {
    this.control = getLoopControl(context.agent);
  }

  private get machine(): LoopMachineContext {
    return this.context.getLogicState<LoopMachineContext>();
  }

  get onDidStartTurn(): Event<TurnStartedEvent> {
    return (listener) => this.machine.startEmitter.event((turnId) => listener({ turnId }));
  }

  get onDidEndTurn(): Event<TurnEndedEvent> {
    return (listener) =>
      this.machine.endEmitter.event(({ turnId, result }) =>
        listener({
          turnId,
          status:
            result.type === 'completed' ? 'settled' : result.type === 'cancelled' ? 'cancelled' : 'idle',
        }),
      );
  }

  async run(_input: { readonly promptId?: string }): Promise<LoopResult> {
    let turnId = this.control.status().activeTurnId;
    if (turnId === undefined) {
      const pending = this.control.status().pendingTurnIds[0];
      if (pending === undefined) return this.machine.lastResult;
      turnId = await new Promise<number>((resolve) => {
        const disposable = this.machine.startEmitter.event((started) => {
          if (started === pending) {
            disposable.dispose();
            resolve(started);
          }
        });
      });
    }
    const result = await this.control.run({ turnId });
    return {
      status:
        result.type === 'completed' ? 'settled' : result.type === 'cancelled' ? 'cancelled' : 'idle',
    };
  }

  async cancel(reason?: string): Promise<void> {
    this.control.cancel(undefined, reason);
  }

  async cancelByUser(reason?: string): Promise<void> {
    this.control.cancelFromUser();
    if (reason !== undefined) this.control.cancel(undefined, reason);
  }

  status(): LoopStatus {
    if (this.control.status().state === 'running') return 'running';
    return this.machine.lastResult.status;
  }

  async waitUntilSettled(): Promise<LoopResult> {
    await this.control.settled();
    return this.machine.lastResult;
  }
}

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
    read: (snapshot) => (snapshot as unknown as { context: LoopMachineContext }).context.state,
    commit: (actor, state) => {
      actor.send({ type: 'loop.commit', state });
    },
  },
  createApi: (context) => new AgentLoopRuntime(context),
});
