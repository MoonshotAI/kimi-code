import { assign, setup, type Snapshot } from 'xstate';

import { toDisposable } from '#/_base/di/lifecycle';
import type { Event } from '#/_base/event';
import type { AgentLLMRequestSource } from '#/features/llmRequester/llmRequester';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';
import type { UsageRecordedContext, UsageStatus } from '#/agent/usage/usage';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { addUsage, type TokenUsage } from '#/kosong/contract/usage';

import {
  copyUsage,
  UsageRecord,
  type UsageRecordScope,
  type UsageState,
} from './usageOps';

export interface UsageRecordInput {
  readonly model: string;
  readonly usage: TokenUsage;
  readonly source?: AgentLLMRequestSource;
}

interface UsageActorContext {
  readonly ledger: UsageState;
  readonly currentTurnId: number | undefined;
  readonly currentTurn: TokenUsage | undefined;
}

interface UsageCommitEvent {
  readonly type: 'usage.commit';
  readonly ledger: UsageState;
}

interface UsageTurnTrackedEvent {
  readonly type: 'usage.turnTracked';
  readonly turnId: number;
  readonly usage: TokenUsage;
}

type UsageActorSnapshot = Snapshot<unknown> & {
  readonly context: UsageActorContext;
};

const usageActorLogic = setup({
  types: {} as {
    context: UsageActorContext;
    input: AgentRuntimeContext<UsageState>;
    events: UsageCommitEvent | UsageTurnTrackedEvent | AgentRuntimeRestoreEvent;
  },
}).createMachine({
  context: () => ({
    ledger: { byModel: {} },
    currentTurnId: undefined,
    currentTurn: undefined,
  }),
  on: {
    'usage.commit': {
      actions: assign({ ledger: ({ event }) => event.ledger }),
    },
    'usage.turnTracked': {
      actions: assign({
        currentTurnId: ({ event }) => event.turnId,
        currentTurn: ({ context, event }) =>
          context.currentTurnId === event.turnId && context.currentTurn !== undefined
            ? addUsage(context.currentTurn, event.usage)
            : copyUsage(event.usage),
      }),
    },
  },
});

export class UsageRuntime {
  private readonly onDidRecordListeners = new Set<(event: UsageRecordedContext) => void>();

  readonly onDidRecord: Event<UsageRecordedContext> = (listener) => {
    this.onDidRecordListeners.add(listener);
    return toDisposable(() => {
      this.onDidRecordListeners.delete(listener);
    });
  };

  constructor(private readonly context: AgentRuntimeContext<UsageState>) {}

  status(): UsageStatus {
    const byModel = Object.fromEntries(
      Object.entries(this.context.getState().byModel).map(([model, usage]) => [
        model,
        copyUsage(usage),
      ]),
    );
    const hasByModel = Object.keys(byModel).length > 0;
    let total: TokenUsage | undefined;
    if (hasByModel) {
      for (const usage of Object.values(byModel)) {
        total = total === undefined ? copyUsage(usage) : addUsage(total, usage);
      }
    }
    const currentTurn = this.context.getLogicState<UsageActorContext>().currentTurn;
    return {
      byModel: hasByModel ? byModel : undefined,
      total,
      currentTurn: currentTurn === undefined ? undefined : copyUsage(currentTurn),
    };
  }

  recordTurn(input: UsageRecordInput): Promise<boolean> {
    const firstRecord = Object.keys(this.context.getState().byModel).length === 0;
    const usageScope: UsageRecordScope = input.source?.type === 'turn' ? 'turn' : 'session';
    const recorded = this.context.dispatch(
      new UsageRecord({
        agentId: this.context.agent.agentId,
        model: input.model,
        usage: input.usage,
        usageScope,
      }),
    );
    const turnId = input.source?.type === 'turn' ? input.source.turnId : undefined;
    if (turnId !== undefined) {
      this.context.send({ type: 'usage.turnTracked', turnId, usage: input.usage });
    }
    const notified = this.context.dispatch(
      new AgentStatusUpdated({ agentId: this.context.agent.agentId, usage: this.status() }),
    );
    return recorded
      .then(() => notified)
      .then(() => {
        const context: UsageRecordedContext = {
          agent: this.context.agent,
          model: input.model,
          usage: copyUsage(input.usage),
          source: input.source,
          firstRecord,
        };
        for (const listener of this.onDidRecordListeners) listener(context);
        return firstRecord;
      });
  }
}

export const AgentUsage = defineAgentRuntimeContract<UsageRuntime>('usage');

export const usageAgentRuntimeProvider = defineAgentRuntimeProvider<UsageState, UsageRuntime>(
  AgentUsage,
  {
    id: 'usage',
    logic: usageActorLogic,
    durable: {
      events: [UsageRecord],
      undoable: false,
      transition: (state, event) => {
        if (event instanceof UsageRecord) {
          const current = state.byModel[event.model];
          state.byModel[event.model] =
            current === undefined ? copyUsage(event.usage) : addUsage(current, event.usage);
        }
        return undefined;
      },
      read: (snapshot) => (snapshot as UsageActorSnapshot).context.ledger,
      commit: (actor, ledger) => {
        actor.send({ type: 'usage.commit', ledger });
      },
    },
    createApi: (context) => new UsageRuntime(context),
    inspect: (snapshot) =>
      Object.keys((snapshot as UsageActorSnapshot).context.ledger.byModel).length,
  },
);
