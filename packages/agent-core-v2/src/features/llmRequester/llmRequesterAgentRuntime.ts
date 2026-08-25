import { assign, setup, type Snapshot } from 'xstate';

import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/agent/runtime/agentRuntime';

import {
  llmRequesterOperationContext,
  type LlmRequesterEffects,
} from '#/features/llmRequester/internal/requestContext';
import {
  prepareTurnConfig,
  request,
  start,
} from '#/features/llmRequester/internal/requestPipeline';
import { ToolCallIdNormalizer } from '#/features/llmRequester/internal/toolCallIdNormalizer';
import type {
  AgentLLMRequestFinish,
  AgentLLMRequestOverrides,
  AgentLLMRequestPartHandler,
  AgentLLMRequestTask,
  PreparedTurnRequestConfig,
} from './llmRequester';
import {
  LlmRequest,
  LlmToolsSnapshot,
  type LlmRequestTraceState,
} from './llmRequesterOps';

interface LlmRequesterActorContext {
  readonly durable: LlmRequestTraceState;
  readonly effects: LlmRequesterEffects;
  readonly runtime: AgentRuntimeContext<LlmRequestTraceState>;
}

interface LlmRequesterCommitEvent {
  readonly type: 'llmRequester.commit';
  readonly durable: LlmRequestTraceState;
}

type LlmRequesterActorEvent = LlmRequesterCommitEvent | AgentRuntimeRestoreEvent;
type LlmRequesterActorSnapshot = Snapshot<unknown> & { readonly context: LlmRequesterActorContext };

export class LlmRequesterRuntime {
  constructor(private readonly runtime: AgentRuntimeContext<LlmRequestTraceState>) {}

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    return prepareTurnConfig(llmRequesterOperationContext(this.runtime), turnId);
  }

  async request(
    overrides: AgentLLMRequestOverrides = {},
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return request(llmRequesterOperationContext(this.runtime), overrides, onPart, signal);
  }

  start(
    overrides: AgentLLMRequestOverrides = {},
    onPart?: AgentLLMRequestPartHandler,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    return start(llmRequesterOperationContext(this.runtime), overrides, onPart, signal);
  }
}

const llmRequesterActorLogic = setup({
  types: {} as {
    context: LlmRequesterActorContext;
    input: AgentRuntimeContext<LlmRequestTraceState>;
    events: LlmRequesterActorEvent;
  },
}).createMachine({
  context: ({ input }) => ({
    durable: { seenToolsHashes: [] },
    effects: {
      turnConfigs: new Map(),
      mediaDegradedTurns: new Set(),
      mediaStrippedTurns: new Map(),
      emittedThinkingEffortWarnings: new Set(),
      lastConfigLogSignature: undefined,
      toolCallIdNormalizer: new ToolCallIdNormalizer(),
    },
    runtime: input,
  }),
  initial: 'beforeRestore',
  states: {
    beforeRestore: {
      on: { 'runtime.restore': 'active' },
    },
    active: {},
  },
  on: {
    'llmRequester.commit': {
      actions: assign({ durable: ({ event }) => event.durable }),
    },
  },
});

export const AgentLlmRequester = defineAgentRuntimeContract<LlmRequesterRuntime>('llmRequester');

export const llmRequesterAgentRuntimeProvider = defineAgentRuntimeProvider<LlmRequestTraceState, LlmRequesterRuntime>(AgentLlmRequester, {
  id: 'llmRequester',
  logic: llmRequesterActorLogic,
  durable: {
    events: [LlmRequest, LlmToolsSnapshot],
    undoable: false,
    transition: (state, event) => {
      if (event instanceof LlmToolsSnapshot) {
        if (state.seenToolsHashes.includes(event.hash)) return;
        state.seenToolsHashes = [...state.seenToolsHashes, event.hash];
      }
    },
    read: (snapshot) => (snapshot as LlmRequesterActorSnapshot).context.durable,
    commit: (actor, durable) => { actor.send({ type: 'llmRequester.commit', durable }); },
  },
  createApi: (context) => new LlmRequesterRuntime(context),
  inspect: (snapshot) => ({
    seenToolsHashes: [...(snapshot as LlmRequesterActorSnapshot).context.durable.seenToolsHashes],
  }),
});
