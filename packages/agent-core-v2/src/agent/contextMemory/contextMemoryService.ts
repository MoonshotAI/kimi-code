/**
 * `contextMemory` domain — `IAgentContextMemoryService` implementation.
 *
 * Owns per-agent conversation history through `wire`, maintains measurements
 * with `tokenCounting`, and broadcasts live mutations through `event`. Every
 * splice-shaped mutation (`clear` / `applyCompaction` / `undo`, plus verified
 * cross-model trailing removal) publishes `context.spliced` from the live path
 * only — replay rebuilds silently — and truncates the measured-anchor ledger
 * when a cut crosses an anchor, letting `tokenCounting` restore the surviving
 * prefix's REAL size from the remaining anchors. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import {
  TokenCountingModel,
  tokenCountingRebased,
  tokenCountingTruncated,
} from '#/agent/tokenCounting/tokenCountingOps';
import { IWireService } from '#/wire/wire';
import type { Op } from '#/wire/op';

import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from './contextMemory';
import { buildContextCompactionShape, type TokenEstimate } from './compactionHandoff';
import {
  computeUndoCut,
  ContextModel,
  contextAppendLoopEvent,
  contextAppendMessage,
  contextApplyCompaction,
  contextClear,
  contextUndo,
  isFullyUndoable,
  type UndoCut,
} from './contextOps';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'context.spliced': {
      start: number;
      deleteCount: number;
      messages: readonly ContextMessage[];
      tokens?: number;
    };
  }
}

// NOTE: stays Disposable — its own 'get' collides with the Fiber
export class AgentContextMemoryService extends Disposable implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentTokenCountingService private readonly tokenCounting: IAgentTokenCountingService,
  ) {
    super();
  }

  private get tokenEstimateFns(): TokenEstimate {
    return {
      text: (text) => this.tokenCounting.estimateText(text),
      message: (message) => this.tokenCounting.estimateMessage(message),
      messages: (messages) => this.tokenCounting.estimateMessages(messages),
    };
  }

  get(): readonly ContextMessage[] {
    return this.wire.getModel(ContextModel) as readonly ContextMessage[];
  }

  append(...messages: readonly ContextMessage[]): void {
    if (messages.length === 0) return;
    const start = this.get().length;
    this.wire.dispatch(...messages.map((message) => contextAppendMessage({ message })));
    this.publishSplice({ start, deleteCount: 0, messages: [...messages] });
  }

  appendLoopEvent(event: LoopRecordedEvent): void {
    this.wire.dispatch(contextAppendLoopEvent({ event }));
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
    this.wire.dispatch(...this.sizeOpsForCut(cutIndex));
    this.publishSplice({ start: cutIndex, deleteCount: 1, messages: [] });
    return true;
  }

  clear(): void {
    const deleteCount = this.get().length;
    if (deleteCount === 0) return;
    this.wire.dispatch(
      contextClear({}),
      tokenCountingRebased({ length: 0, tokens: 0, measured: true }),
    );
    this.publishSplice({ start: 0, deleteCount, messages: [] });
  }

  undo(count: number): UndoCut {
    const history = this.get();
    const cut = computeUndoCut(history, count);
    if (isFullyUndoable(cut, count)) {
      this.wire.dispatch(contextUndo({ count }), ...this.sizeOpsForCut(cut.cutIndex));
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
    this.wire.dispatch(
      contextApplyCompaction({
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
      tokenCountingRebased({
        length: result.messages.length,
        tokens: result.tokensAfter,
        measured: false,
      }),
    );
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

  private publishSplice(input: {
    start: number;
    deleteCount: number;
    messages: readonly ContextMessage[];
    tokens?: number;
  }): void {
    this.eventBus.publish({ type: 'context.spliced', ...input });
  }

  private sizeOpsForCut(cutIndex: number): Op[] {
    const model = this.wire.getModel(TokenCountingModel);
    if (!model.anchors.some((anchor) => anchor.length > cutIndex)) return [];
    // The display tokens are the post-cut size computed from the CURRENT
    // ledger — anchors at or below the cut are identical before and after
    // the truncation, so the pre-dispatch read is exact.
    return [
      tokenCountingTruncated({
        length: cutIndex,
        tokens: this.tokenCounting.get(0, cutIndex).size,
      }),
    ];
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  ScopeActivation.OnScopeCreated,
  'contextMemory',
);
