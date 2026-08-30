import { assign, setup } from 'xstate';

import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import type {
  AgentLLMRequestFinish,
  AgentLLMRequestOverrides,
  AgentLLMRequestPartHandler,
  AgentLLMRequestTask,
  PreparedTurnRequestConfig,
} from '#/actor/llmRequester/llmRequester';
import {
  LlmRequest,
  LlmToolsSnapshot,
  type LlmRequestTraceState,
} from '#/actor/llmRequester/llmRequesterOps';
import {
  type LlmRequesterActorContext,
  type LlmRequesterActorEvent,
  type LlmRequesterActorSnapshot,
} from '#/actor/llmRequester/internal/actorContext';
import { LlmRequestExecutor } from '#/actor/llmRequester/internal/requestExecutor';

function setWithAll(set: ReadonlySet<string>, values: readonly string[]): ReadonlySet<string> {
  if (values.length === 0) return set;
  const next = new Set(set);
  for (const value of values) next.add(value);
  return next;
}

function setWith(set: ReadonlySet<string>, value: string): ReadonlySet<string> {
  if (set.has(value)) return set;
  const next = new Set(set);
  next.add(value);
  return next;
}

function turnMapWith<V>(map: ReadonlyMap<number, V>, turnId: number, value: V): ReadonlyMap<number, V> {
  const next = new Map<number, V>();
  for (const [id, existing] of map) {
    if (id >= turnId) next.set(id, existing);
  }
  next.set(turnId, value);
  return next;
}

function turnSetWith(set: ReadonlySet<number>, turnId: number): ReadonlySet<number> {
  const next = new Set<number>();
  for (const id of set) {
    if (id >= turnId) next.add(id);
  }
  next.add(turnId);
  return next;
}

const llmRequesterActorLogic = setup({
  types: {} as {
    context: LlmRequesterActorContext;
    input: AgentRuntimeContext<LlmRequestTraceState>;
    events: LlmRequesterActorEvent | AgentRuntimeRestoreEvent;
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    ledger: { seenToolsHashes: [] },
    seenToolCallIds: new Set(),
    toolCallIdsSeeded: false,
    turnConfigs: new Map(),
    mediaDegradedTurns: new Set(),
    mediaStrippedTurns: new Map(),
    emittedThinkingEffortWarnings: new Set(),
    lastConfigLogSignature: undefined,
  }),
  on: {
    'llmRequester.commit': {
      actions: assign({ ledger: ({ event }) => event.ledger }),
    },
    'llmRequester.toolCallIdsSeeded': {
      actions: assign(({ context, event }) => {
        if (context.toolCallIdsSeeded) return {};
        return {
          toolCallIdsSeeded: true,
          seenToolCallIds: setWithAll(context.seenToolCallIds, event.ids),
        };
      }),
    },
    'llmRequester.toolCallIdsClaimed': {
      actions: assign({
        seenToolCallIds: ({ context, event }) => setWithAll(context.seenToolCallIds, event.ids),
      }),
    },
    'llmRequester.turnConfigCached': {
      actions: assign({
        turnConfigs: ({ context, event }) => turnMapWith(context.turnConfigs, event.turnId, event.config),
      }),
    },
    'llmRequester.mediaDegradedMarked': {
      actions: assign({
        mediaDegradedTurns: ({ context, event }) => turnSetWith(context.mediaDegradedTurns, event.turnId),
      }),
    },
    'llmRequester.mediaStripCaptured': {
      actions: assign({
        mediaStrippedTurns: ({ context, event }) =>
          turnMapWith(context.mediaStrippedTurns, event.turnId, event.snapshot),
      }),
    },
    'llmRequester.thinkingWarningEmitted': {
      actions: assign({
        emittedThinkingEffortWarnings: ({ context, event }) =>
          setWith(context.emittedThinkingEffortWarnings, event.key),
      }),
    },
    'llmRequester.configLogSignature': {
      actions: assign({ lastConfigLogSignature: ({ event }) => event.signature }),
    },
  },
});

export class LlmRequesterRuntime {
  private readonly executor: LlmRequestExecutor;

  constructor(context: AgentRuntimeContext<LlmRequestTraceState>) {
    this.executor = new LlmRequestExecutor(context);
  }

  getRequestConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    return this.executor.prepareTurnConfig(turnId);
  }

  generate(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return this.executor.request(overrides, onPart, signal);
  }

  stream(
    overrides?: AgentLLMRequestOverrides,
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    return this.executor.start(overrides, onPart, signal);
  }
}

export const AgentLlmRequester = defineAgentRuntimeContract<LlmRequesterRuntime>('llmRequester');

export const llmRequesterAgentRuntimeProvider = defineAgentRuntimeProvider<
  LlmRequestTraceState,
  LlmRequesterRuntime
>(AgentLlmRequester, {
  id: 'llmRequester',
  logic: llmRequesterActorLogic,
  durable: {
    events: [LlmToolsSnapshot, LlmRequest],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof LlmToolsSnapshot) {
        if (state.seenToolsHashes.includes(event.hash)) return;
        state.seenToolsHashes = [...state.seenToolsHashes, event.hash];
        return;
      }
      return undefined;
    },
    read: (snapshot) => (snapshot as LlmRequesterActorSnapshot).context.ledger,
    commit: (actor, ledger) => {
      actor.send({ type: 'llmRequester.commit', ledger });
    },
  },
  createApi: (context) => new LlmRequesterRuntime(context),
  inspect: (snapshot) =>
    (snapshot as LlmRequesterActorSnapshot).context.ledger.seenToolsHashes.length,
});
