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
  type LlmRequesterActorSnapshot,
  type LlmRequesterCommitEvent,
  type LlmRequesterPatchEvent,
} from '#/actor/llmRequester/internal/actorContext';
import { LlmRequestExecutor } from '#/actor/llmRequester/internal/requestExecutor';
import { ToolCallIdNormalizer } from '#/actor/llmRequester/internal/toolCallIdNormalizer';

const llmRequesterActorLogic = setup({
  types: {} as {
    context: LlmRequesterActorContext;
    input: AgentRuntimeContext<LlmRequestTraceState>;
    events: LlmRequesterCommitEvent | LlmRequesterPatchEvent | AgentRuntimeRestoreEvent;
  },
}).createMachine({
  context: ({ input }) => ({
    runtime: input,
    ledger: { seenToolsHashes: [] },
    toolCallIdNormalizer: new ToolCallIdNormalizer(),
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
    'llmRequester.patch': {
      actions: assign(({ context, event }) => ({ ...context, ...event.patch })),
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
