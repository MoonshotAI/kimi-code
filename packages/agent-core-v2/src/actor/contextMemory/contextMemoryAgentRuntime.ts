import { assign, setup, type Snapshot } from 'xstate';

import type { Event } from '#/_base/event';
import {
  defineAgentRuntimeContract,
  defineAgentRuntimeProvider,
  type AgentRuntimeContext,
  type AgentRuntimeRestoreEvent,
} from '#/actor/agentRuntime';
import { SwarmModeExit } from '#/features/swarm/swarmOps';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';

import { buildContextCompactionShape, type TokenEstimate } from './compactionHandoff';
import {
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextApplyCompaction,
  ContextClear,
  ContextSpliced,
  ContextUndo,
  type ContextApplyCompactionPayload,
  type ContextSplicedPayload,
} from './contextEvents';
import {
  applyContextCompactionRecord,
  computeUndoCut,
  isFullyUndoable,
  popSwarmModeReminder,
} from './contextOps';
import {
  dehydrateContextMemoryMessages,
  dehydrateContextMemoryRecord,
} from './internal/contextMemoryBlobs';
import { foldAppendMessage, foldLoopEvent, resetFold } from './loopEventFold';
import type { ContextMessage } from './types';

export interface ContextCompactionInput {
  readonly summary: string;
  readonly contextSummary?: string;
  readonly compactedCount: number;
  readonly tokensBefore: number;
  readonly tokensAfter?: number;
  readonly summaryOutputTokens?: number;
  readonly requestOverheadTokens?: number;
  readonly keptUserMessageCount?: number;
  readonly keptHeadUserMessageCount?: number;
  readonly droppedCount?: number;
}

export interface ContextCompactionResult {
  summary: string;
  contextSummary: string;
  compactedCount: number;
  tokensBefore: number;
  tokensAfter: number;
  keptUserMessageCount: number;
  keptHeadUserMessageCount?: number;
  droppedCount?: number;
}

export interface ContextMemoryChangeEvent {
  readonly messages: readonly ContextMessage[];
}

interface ContextMemoryActorContext {
  readonly messages: ContextMessage[];
}

interface ContextMemoryCommitEvent {
  readonly type: 'contextMemory.commit';
  readonly messages: ContextMessage[];
}

type ContextMemoryActorSnapshot = Snapshot<unknown> & {
  readonly context: ContextMemoryActorContext;
};

const contextMemoryActorLogic = setup({
  types: {} as {
    context: ContextMemoryActorContext;
    input: AgentRuntimeContext<ContextMessage[]>;
    events: ContextMemoryCommitEvent | AgentRuntimeRestoreEvent;
  },
}).createMachine({
  context: () => ({ messages: [] }),
  on: {
    'contextMemory.commit': {
      actions: assign({ messages: ({ event }) => event.messages }),
    },
  },
});

export class ContextMemoryRuntime {
  readonly onDidChange: Event<ContextMemoryChangeEvent>;

  constructor(private readonly context: AgentRuntimeContext<ContextMessage[]>) {
    this.onDidChange = (listener) =>
      this.context.onDidChange((messages) => listener({ messages }));
  }

  get(): readonly ContextMessage[] {
    return this.context.getState();
  }

  append(...messages: readonly ContextMessage[]): Promise<void> {
    if (messages.length === 0) return Promise.resolve();
    const start = this.get().length;
    for (const message of messages) {
      void this.context.dispatch(
        new ContextAppendMessage({ agentId: this.context.agent.agentId, message }),
      );
    }
    this.publishSplice({ start, deleteCount: 0, messages: [...messages] });
    return Promise.resolve();
  }

  publishTrailingRemoval(previous: readonly ContextMessage[]): boolean {
    const cutIndex = previous.length - 1;
    if (cutIndex < 0) return false;
    const current = this.get();
    if (
      current.length !== cutIndex ||
      current.some((message, index) => message !== previous[index])
    ) {
      return false;
    }
    this.tokenCounting().recordTruncation(this.context.agent, cutIndex);
    this.publishSplice({ start: cutIndex, deleteCount: 1, messages: [] });
    return true;
  }

  clear(): Promise<void> {
    const deleteCount = this.get().length;
    if (deleteCount === 0) return Promise.resolve();
    void this.context.dispatch(new ContextClear({ agentId: this.context.agent.agentId }));
    this.tokenCounting().rebase(this.context.agent, {
      length: 0,
      tokens: 0,
      measured: true,
    });
    this.publishSplice({ start: 0, deleteCount, messages: [] });
    return Promise.resolve();
  }

  undo(count: number): Promise<boolean> {
    const history = this.get();
    const cut = computeUndoCut(history, count);
    if (!isFullyUndoable(cut, count)) return Promise.resolve(false);
    void this.context.dispatch(
      new ContextUndo({ agentId: this.context.agent.agentId, count }),
    );
    this.tokenCounting().recordTruncation(this.context.agent, cut.cutIndex);
    this.publishSplice({
      start: cut.cutIndex,
      deleteCount: history.length - cut.cutIndex,
      messages: [],
    });
    return Promise.resolve(true);
  }

  applyCompaction(input: ContextCompactionInput): Promise<ContextCompactionResult> {
    const history = this.get();
    const result = buildContextCompactionShape(history, input, this.tokenEstimateFns);
    void this.context.dispatch(
      new ContextApplyCompaction({
        agentId: this.context.agent.agentId,
        summary: result.summary,
        contextSummary: result.contextSummary,
        compactedCount: result.compactedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        summaryOutputTokens: input.summaryOutputTokens,
        keptUserMessageCount: result.keptUserMessageCount,
        keptHeadUserMessageCount: result.keptHeadUserMessageCount,
        droppedCount: result.droppedCount,
      }),
    );
    this.tokenCounting().rebase(this.context.agent, {
      length: result.messages.length,
      tokens: result.tokensAfter,
      measured: false,
    });
    this.publishSplice({
      start: 0,
      deleteCount: history.length,
      messages: [...result.messages],
      tokens: result.tokensAfter,
    });
    const { messages: _messages, ...publicResult } = result;
    void _messages;
    return Promise.resolve(publicResult);
  }

  private tokenCounting(): ISessionTokenCountingService {
    return this.context.get(ISessionTokenCountingService);
  }

  private get tokenEstimateFns(): TokenEstimate {
    return {
      text: (text) => this.tokenCounting().estimateText(text),
      message: (message) => this.tokenCounting().estimateMessage(message),
      messages: (messages) => this.tokenCounting().estimateMessages(messages),
    };
  }

  private publishSplice(input: Omit<ContextSplicedPayload, 'agentId'>): void {
    void this.context.dispatch(
      new ContextSpliced({ agentId: this.context.agent.agentId, ...input }),
    );
  }
}

export const AgentContextMemory = defineAgentRuntimeContract<ContextMemoryRuntime>('contextMemory');

export const contextMemoryAgentRuntimeProvider = defineAgentRuntimeProvider<
  ContextMessage[],
  ContextMemoryRuntime
>(AgentContextMemory, {
  id: 'contextMemory',
  logic: contextMemoryActorLogic,
  durable: {
    events: [
      ContextAppendMessage,
      ContextAppendLoopEvent,
      ContextClear,
      ContextApplyCompaction,
      SwarmModeExit,
    ],
    undoable: true,
    onUndo: (state, count) => {
      if (state.length === 0) return;
      const cut = computeUndoCut(state, count);
      if (!isFullyUndoable(cut, count)) return;
      return resetFold(state.slice(0, cut.cutIndex)) as ContextMessage[];
    },
    blobs: {
      dehydrate: dehydrateContextMemoryRecord,
      rehydrate: async (state, transform) => {
        const { changed, result } = await dehydrateContextMemoryMessages(state, transform);
        return changed ? result : state;
      },
    },
    transition: (state, event) => {
      if (event instanceof ContextAppendMessage) {
        return foldAppendMessage(state, event.message) as ContextMessage[];
      }
      if (event instanceof ContextAppendLoopEvent) {
        return foldLoopEvent(state, event.event) as ContextMessage[];
      }
      if (event instanceof ContextClear) {
        return state.length === 0 ? undefined : (resetFold([]) as ContextMessage[]);
      }
      if (event instanceof ContextApplyCompaction) {
        return applyContextCompactionRecord(
          state,
          event as unknown as ContextApplyCompactionPayload,
        );
      }
      if (event instanceof SwarmModeExit) {
        return popSwarmModeReminder(state);
      }
      return undefined;
    },
    read: (snapshot) => (snapshot as ContextMemoryActorSnapshot).context.messages,
    commit: (actor, messages) => {
      actor.send({ type: 'contextMemory.commit', messages });
    },
  },
  createApi: (context) => new ContextMemoryRuntime(context),
  inspect: (snapshot) => (snapshot as ContextMemoryActorSnapshot).context.messages.length,
});
