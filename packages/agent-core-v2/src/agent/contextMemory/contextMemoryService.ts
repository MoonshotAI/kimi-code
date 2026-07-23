/**
 * `contextMemory` domain (L4) — `IAgentContextMemoryService` implementation.
 *
 * Owns per-agent conversation history through `wire`, maintains measurements
 * with `contextSize`, and broadcasts live mutations through `event`. Every
 * splice-shaped mutation (`clear` / `applyCompaction` / `undo`) publishes
 * `context.spliced` from the live path only — replay rebuilds silently — and
 * `undo` additionally rebases the measured token prefix to an estimate when
 * the cut truncates it. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/kosong/contract/tokens';
import { IEventBus } from '#/app/event/eventBus';
import { ContextSizeModel, contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import { IWireService } from '#/wire/wire';
import type { Op } from '#/wire/op';

import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from './contextMemory';
import { buildContextCompactionShape } from './compactionHandoff';
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

export class AgentContextMemoryService extends Disposable implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
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

  clear(): void {
    const deleteCount = this.get().length;
    if (deleteCount === 0) return;
    this.wire.dispatch(contextClear({}), contextSizeMeasured({ length: 0, tokens: 0 }));
    this.publishSplice({ start: 0, deleteCount, messages: [] });
  }

  undo(count: number): UndoCut {
    const history = this.get();
    const cut = computeUndoCut(history, count);
    if (isFullyUndoable(cut, count)) {
      this.wire.dispatch(contextUndo({ count }), ...this.sizeOpsForCut(cut.cutIndex, history));
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
    const result = buildContextCompactionShape(history, input);
    this.wire.dispatch(
      contextApplyCompaction({
        summary: result.summary,
        contextSummary: result.contextSummary,
        compactedCount: result.compactedCount,
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        keptUserMessageCount: result.keptUserMessageCount,
        keptHeadUserMessageCount: result.keptHeadUserMessageCount,
        droppedCount: result.droppedCount,
      }),
      contextSizeMeasured({ length: result.messages.length, tokens: result.tokensAfter }),
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

  private sizeOpsForCut(cutIndex: number, history: readonly ContextMessage[]): Op[] {
    const model = this.wire.getModel(ContextSizeModel);
    if (model.length <= cutIndex) return [];
    return [
      contextSizeMeasured({
        length: cutIndex,
        tokens: estimateTokensForMessages(history.slice(0, cutIndex)),
      }),
    ];
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  InstantiationType.Eager,
  'contextMemory',
);
