/**
 * `contextMemory` domain (L4) — `IAgentContextMemoryService` implementation.
 *
 * Owns the per-agent conversation history in the wire `ContextModel`
 * (`ContextMessage[]`): reads through `wire.getModel`, writes through the
 * wire-protocol 1.4 Ops (`append` / `clear` / `undo` / `applyCompaction`), with
 * `splice` retained for protocol 1.5 replay and the rare internal single-delete.
 * As the sole live mutation gateway for the history, it also cascades a
 * `context_size.measured` Op alongside every mutation that changes the measured
 * prefix — `clear` resets it, `applyCompaction` adopts `tokensAfter`, and
 * `undo` / `splice` rebase it (to an estimate when the measured aggregate is
 * truncated); `append` leaves the measured prefix untouched since new messages
 * are the unmeasured tail (see `contextSizeService`). Every mutation still fires
 * `onSpliced` from the live path only (replay rebuilds
 * the Model silently and never invokes these methods), so existing subscribers
 * (micro-compaction, context-injector, task-notification) observe the same
 * splice-shaped change events regardless of which 1.4 Op was persisted. Message
 * ids are stamped at the dispatch call site so `apply` stays pure. Blob
 * dehydrate/rehydrate is declared on `ContextModel.blobs`. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { estimateTokensForMessages } from '#/_base/utils/tokens';
import { IEventBus } from '#/app/event/eventBus';
import { ContextSizeModel, contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import { IAgentWireService } from '#/wire/tokens';
import type { Op } from '#/wire/op';
import type { IWireService } from '#/wire/wireService';

import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from './contextMemory';
import { buildContextCompactionShape } from './compactionHandoff';
import {
  computeUndoCut,
  ContextModel,
  contextAppendMessage,
  contextApplyCompaction,
  contextClear,
  contextSplice,
  contextUndo,
  type UndoCut,
} from './contextOps';
import { ensureMessageId } from './messageId';
import type { ContextMessage } from './types';

declare module '#/agent/wireRecord/wireRecord' {
  interface WireRecordMap {
    'context.splice': {
      start: number;
      deleteCount: number;
      messages: readonly ContextMessage[];
      tokens?: number;
    };
  }
}

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
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
  }

  get(): readonly ContextMessage[] {
    return this.wire.getModel(ContextModel) as readonly ContextMessage[];
  }

  append(...messages: readonly ContextMessage[]): void {
    if (messages.length === 0) return;
    const stamped = messages.map(ensureMessageId);
    const start = this.get().length;
    this.wire.dispatch(...stamped.map((message) => contextAppendMessage({ message })));
    this.eventBus.publish({ type: 'context.spliced',
      start,
      deleteCount: 0,
      messages: [...stamped],
    });
  }

  clear(): void {
    const deleteCount = this.get().length;
    if (deleteCount === 0) return;
    this.wire.dispatch(contextClear({}), contextSizeMeasured({ length: 0, tokens: 0 }));
    this.eventBus.publish({ type: 'context.spliced', start: 0, deleteCount, messages: [] });
  }

  undo(count: number): UndoCut {
    const history = this.get();
    const cut = computeUndoCut(history, count);
    if (cut.cutIndex >= 0 && cut.removedCount >= count) {
      this.wire.dispatch(contextUndo({ count }), ...this.sizeOpsForCut(cut.cutIndex, history));
      this.eventBus.publish({ type: 'context.spliced',
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
    this.eventBus.publish({ type: 'context.spliced',
      start: 0,
      deleteCount: history.length,
      messages: [...result.messages],
      tokens: result.tokensAfter,
    });
    const { messages: _messages, ...publicResult } = result;
    void _messages;
    return publicResult;
  }

  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void {
    const stamped = messages.map(ensureMessageId);
    this.wire.dispatch(
      contextSplice({ start, deleteCount, messages: stamped, tokens }),
      ...this.sizeOpsForSplice(start, deleteCount, stamped, tokens),
    );
    this.eventBus.publish({ type: 'context.spliced',
      start,
      deleteCount,
      messages: [...stamped],
      tokens,
    });
  }

  /**
   * Cascade a `context_size.measured` Op when an undo truncates the measured
   * prefix (`ContextSizeModel.length`). If the surviving context still covers
   * the measured prefix, the measurement stays valid and nothing is emitted;
   * otherwise the prefix is rebased to an estimate of the surviving messages
   * (an aggregate measured count can't be truncated without per-message data).
   */
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

  /**
   * Cascade a `context_size.measured` Op when a splice touches the measured
   * prefix. A splice confined to the unmeasured tail leaves the prefix intact
   * and emits nothing; a splice that reaches into the prefix invalidates the
   * measured aggregate, so the whole surviving context is rebased to an
   * estimate (caller-provided `tokens` win when present).
   */
  private sizeOpsForSplice(
    start: number,
    deleteCount: number,
    inserted: readonly ContextMessage[],
    tokens?: number,
  ): Op[] {
    const model = this.wire.getModel(ContextSizeModel);
    if (start >= model.length) return [];
    const next = this.get().slice();
    next.splice(start, deleteCount, ...inserted);
    return [
      contextSizeMeasured({
        length: next.length,
        tokens: tokens ?? estimateTokensForMessages(next),
      }),
    ];
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  InstantiationType.Delayed,
  'contextMemory',
);
