import { assign, fromCallback, setup, type Snapshot } from 'xstate';

import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import { TurnEnded } from '#/actor/loop/turnOps';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IConfigService } from '#/app/config/config';
import { ISessionEventBus } from '#/app/event/eventBus';
import { AgentContextMemory } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import type { ContextMessage } from '#/actor/contextMemory/types';
import type { Message } from '#/kosong/contract/message';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import type { TokenUsage } from '#/kosong/contract/usage';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

import { readTokenCountingStrategy } from './configSection';
import type {
  ContextSize,
  TokenCountingRebaseInput,
  TokenCountingStrategy,
} from './tokenCounting';
import {
  anchorsEqual,
  normalizeAnchorLength,
  TokenCountingMeasured,
  TokenCountingRebased,
  TokenCountingTruncated,
  TokenCountingTurnRecorded,
  type TokenAnchor,
  type TokenCountingState,
} from './tokenCountingOps';

const ZERO_ANCHOR: TokenAnchor = { length: 0, tokens: 0, measured: true };

interface TokenCountingActorContext {
  readonly ledger: TokenCountingState;
  readonly runtime: AgentRuntimeContext<TokenCountingState>;
}

interface TokenCountingCommitEvent {
  readonly type: 'tokenCounting.commit';
  readonly ledger: TokenCountingState;
}

type TokenCountingLedgerEvent =
  | TokenCountingMeasured
  | TokenCountingTruncated
  | TokenCountingRebased
  | TokenCountingTurnRecorded;

type TokenCountingActorSnapshot = Snapshot<unknown> & {
  readonly context: TokenCountingActorContext;
};

const tokenCountingTurnRecorder = fromCallback(
  ({ input }: { input: AgentRuntimeContext<TokenCountingState> }) => {
    const subscription = input
      .get(ISessionEventBus)
      .onAgent(input.agent, TurnEnded, (event) => {
        void recordTurnFact(input, event.turnId);
      });
    return () => {
      subscription.dispose();
    };
  },
);

const tokenCountingActorLogic = setup({
  types: {} as {
    context: TokenCountingActorContext;
    input: AgentRuntimeContext<TokenCountingState>;
    events: TokenCountingCommitEvent | AgentRuntimeRestoreEvent;
  },
  actors: { tokenCountingTurnRecorder },
}).createMachine({
  context: ({ input }) => ({ ledger: { anchors: [], tokens: 0 }, runtime: input }),
  invoke: {
    src: 'tokenCountingTurnRecorder',
    input: ({ context }) => context.runtime,
  },
  on: {
    'tokenCounting.commit': {
      actions: assign({ ledger: ({ event }) => event.ledger }),
    },
  },
});

export class TokenCountingRuntime {
  constructor(private readonly context: AgentRuntimeContext<TokenCountingState>) {}

  get(start?: number, end?: number): ContextSize {
    return contextSizeOf(this.context.getState(), this.messages(), start, end);
  }

  statusSize(): number {
    return statusSizeOf(
      this.context.getState(),
      this.messages(),
      readTokenCountingStrategy(this.context.get(IConfigService)),
    );
  }

  latestMeasured(): number {
    return latestMeasuredOf(this.context.getState());
  }

  measured(input: readonly Message[], usage: TokenUsage): Promise<void> {
    const messages = this.messages();
    if (!matchesContext(input, messages)) return Promise.resolve();
    return this.context.dispatch(
      new TokenCountingMeasured({
        agentId: this.context.agent.agentId,
        length: messages.length,
        tokens: tokenUsageTotal(usage),
      }),
    );
  }

  rebase(input: TokenCountingRebaseInput): Promise<void> {
    return this.context.dispatch(
      new TokenCountingRebased({
        agentId: this.context.agent.agentId,
        length: input.length,
        tokens: input.tokens,
        measured: input.measured,
      }),
    );
  }

  recordTruncation(cutIndex: number): Promise<void> {
    if (!this.context.getState().anchors.some((anchor) => anchor.length > cutIndex)) {
      return Promise.resolve();
    }
    return this.context.dispatch(
      new TokenCountingTruncated({
        agentId: this.context.agent.agentId,
        length: cutIndex,
        tokens: this.get(0, cutIndex).size,
      }),
    );
  }

  recordTurn(turnId: number): Promise<void> {
    return recordTurnFact(this.context, turnId);
  }

  private messages(): readonly ContextMessage[] {
    return this.context
      .get(IAgentLifecycleService)
      .resolve(this.context.agent, AgentContextMemory)
      .get();
  }
}

export const AgentTokenCounting =
  defineAgentRuntimeContract<TokenCountingRuntime>('tokenCounting');

export const tokenCountingAgentRuntimeProvider = defineAgentRuntimeProvider<
  TokenCountingState,
  TokenCountingRuntime
>(AgentTokenCounting, {
  id: 'tokenCounting',
  logic: tokenCountingActorLogic,
  durable: {
    events: [
      TokenCountingMeasured,
      TokenCountingTruncated,
      TokenCountingRebased,
      TokenCountingTurnRecorded,
    ],
    undoable: false,
    transition: (state, event, ctx) => {
      if (
        event instanceof TokenCountingMeasured ||
        event instanceof TokenCountingTruncated ||
        event instanceof TokenCountingRebased ||
        event instanceof TokenCountingTurnRecorded
      ) {
        const next = foldTokenCountingLedger(state, event);
        ctx.emit(
          new AgentStatusUpdated({
            agentId: event.agentId,
            contextTokens: next === undefined ? state.tokens : next.tokens,
          }),
        );
        return next;
      }
      return undefined;
    },
    read: (snapshot) => (snapshot as TokenCountingActorSnapshot).context.ledger,
    commit: (actor, ledger) => {
      actor.send({ type: 'tokenCounting.commit', ledger });
    },
  },
  createApi: (context) => new TokenCountingRuntime(context),
  inspect: (snapshot) => (snapshot as TokenCountingActorSnapshot).context.ledger.tokens,
});

function recordTurnFact(
  runtime: AgentRuntimeContext<TokenCountingState>,
  turnId: number,
): Promise<void> {
  const messages = runtime
    .get(IAgentLifecycleService)
    .resolve(runtime.agent, AgentContextMemory)
    .get();
  const strategy = readTokenCountingStrategy(runtime.get(IConfigService));
  return runtime.dispatch(
    new TokenCountingTurnRecorded({
      agentId: runtime.agent.agentId,
      turnId,
      length: messages.length,
      tokens: statusSizeOf(runtime.getState(), messages, strategy),
    }),
  );
}

function foldTokenCountingLedger(
  state: TokenCountingState,
  event: TokenCountingLedgerEvent,
): TokenCountingState | undefined {
  const length = normalizeAnchorLength(event.length);
  const tokens = Math.max(0, event.tokens);
  let anchors: readonly TokenAnchor[];
  if (event instanceof TokenCountingMeasured) {
    anchors = [...state.anchors.filter((anchor) => anchor.length < length), { length, tokens, measured: true }];
  } else if (event instanceof TokenCountingTruncated) {
    anchors = state.anchors.filter((anchor) => anchor.length <= length);
  } else if (event instanceof TokenCountingRebased) {
    anchors = [{ length, tokens, measured: event.measured }];
  } else {
    if (state.anchors.some((anchor) => anchor.length === length)) {
      anchors = state.anchors;
    } else {
      anchors = [...state.anchors.filter((anchor) => anchor.length < length), { length, tokens, measured: false }];
    }
  }
  if (state.tokens === tokens && anchorsEqual(state.anchors, anchors)) return undefined;
  return { anchors, tokens };
}

function latestAnchorOf(state: TokenCountingState, contextLength: number): TokenAnchor {
  const anchors = state.anchors;
  for (let i = anchors.length - 1; i >= 0; i--) {
    const anchor = anchors[i]!;
    if (anchor.length <= contextLength) return anchor;
  }
  return ZERO_ANCHOR;
}

function latestMeasuredOf(state: TokenCountingState): number {
  const anchors = state.anchors;
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (anchors[i]!.measured) return anchors[i]!.tokens;
  }
  return 0;
}

function contextSizeOf(
  state: TokenCountingState,
  messages: readonly Message[],
  start?: number,
  end?: number,
): ContextSize {
  const from = normalizeSliceIndex(start ?? 0, messages.length);
  const to = normalizeSliceIndex(end ?? messages.length, messages.length);
  const anchor = latestAnchorOf(state, messages.length);
  const measuredEnd = Math.min(to, anchor.length);
  const estimatedStart = Math.max(from, anchor.length);
  const measured =
    from === 0 && measuredEnd === anchor.length
      ? anchor.tokens
      : estimateTokensForMessages(messages.slice(from, measuredEnd));
  const estimated = estimateTokensForMessages(messages.slice(estimatedStart, to));
  return { size: measured + estimated, measured, estimated };
}

function statusSizeOf(
  state: TokenCountingState,
  messages: readonly Message[],
  strategy: TokenCountingStrategy,
): number {
  if (strategy === 'measured') return latestMeasuredOf(state);
  if (strategy === 'estimated') return estimateTokensForMessages(messages);
  return Math.max(contextSizeOf(state, messages).size, latestMeasuredOf(state));
}

function matchesContext(input: readonly Message[], context: readonly Message[]): boolean {
  if (input.length !== context.length) return false;
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== context[index]) return false;
  }
  return true;
}

function tokenUsageTotal(usage: TokenUsage): number {
  return usage.inputCacheRead + usage.inputCacheCreation + usage.inputOther + usage.output;
}

function normalizeSliceIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}
