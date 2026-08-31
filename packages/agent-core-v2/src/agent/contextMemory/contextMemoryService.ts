import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from './contextMemory';
import { buildContextCompactionShape, type TokenEstimate } from './compactionHandoff';
import {
  ContextApplyCompaction,
  ContextAppendLoopEvent,
  ContextAppendMessage,
  ContextClear,
  ContextSpliced,
  ContextUndo,
  type ContextSplicedPayload,
} from './contextEvents';
import {
  computeUndoCut,
  contextMemoryKey,
  isFullyUndoable,
  type UndoCut,
} from './contextOps';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

export class AgentContextMemoryService extends Disposable implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISessionTokenCountingService private readonly tokenCounting: ISessionTokenCountingService,
    @IAgentStateService private readonly agentState: IAgentStateService,
  ) {
    super();
    this.agentState.contributeState(contextMemoryKey);
  }

  private get tokenEstimateFns(): TokenEstimate {
    return {
      text: (text) => this.tokenCounting.estimateText(text),
      message: (message) => this.tokenCounting.estimateMessage(message),
      messages: (messages) => this.tokenCounting.estimateMessages(messages),
    };
  }

  get(): readonly ContextMessage[] {
    return this.agentState.get(contextMemoryKey) as readonly ContextMessage[];
  }

  append(...messages: readonly ContextMessage[]): void {
    if (messages.length === 0) return;
    const start = this.get().length;
    for (const message of messages) {
      void this.dispatcher.dispatch(
        new ContextAppendMessage({ agentId: this.scopeContext.agentId, message }),
      );
    }
    this.publishSplice({ start, deleteCount: 0, messages: [...messages] });
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    void this.dispatcher.dispatch(
      new ContextAppendLoopEvent({ agentId: this.scopeContext.agentId, event }),
    );
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
    this.dispatchCutEvents(cutIndex);
    this.publishSplice({ start: cutIndex, deleteCount: 1, messages: [] });
    return true;
  }

  clear(): void {
    const deleteCount = this.get().length;
    if (deleteCount === 0) return;
    void this.dispatcher.dispatch(new ContextClear({ agentId: this.scopeContext.agentId }));
    this.tokenCounting.rebase(this.scopeContext.agentContext, {
      length: 0,
      tokens: 0,
      measured: true,
    });
    this.publishSplice({ start: 0, deleteCount, messages: [] });
  }

  undo(count: number): UndoCut {
    const history = this.get();
    const cut = computeUndoCut(history, count);
    if (isFullyUndoable(cut, count)) {
      void this.dispatcher.dispatch(
        new ContextUndo({ agentId: this.scopeContext.agentId, count }),
      );
      this.dispatchCutEvents(cut.cutIndex);
      this.publishSplice({
        start: cut.cutIndex,
        deleteCount: history.length - cut.cutIndex,
        messages: [],
      });
    }
    return cut;
  }

  applyCompaction(input: ContextCompactionInput): ContextCompactionResult {
    const history = this.get();
    const result = buildContextCompactionShape(history, input, this.tokenEstimateFns);
    void this.dispatcher.dispatch(
      new ContextApplyCompaction({
        agentId: this.scopeContext.agentId,
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
    this.tokenCounting.rebase(this.scopeContext.agentContext, {
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
    return publicResult;
  }

  private publishSplice(input: Omit<ContextSplicedPayload, 'agentId'>): void {
    void this.dispatcher.dispatch(
      new ContextSpliced({ agentId: this.scopeContext.agentId, ...input }),
    );
  }

  private dispatchCutEvents(cutIndex: number): void {
    this.tokenCounting.recordTruncation(this.scopeContext.agentContext, cutIndex);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  ScopeActivation.OnScopeCreated,
  'contextMemory',
);
