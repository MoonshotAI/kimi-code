/**
 * `contextMemory` domain (L4) — `IAgentContextMemoryService` implementation.
 *
 * Owns the per-agent conversation history in the wire `ContextModel`
 * (`ContextMessage[]`): reads through `wire.getModel`, writes through the
 * wire-protocol 1.4 Ops (`append` / `clear` / `undo` / `applyCompaction`), with
 * `splice` retained for protocol 1.5 replay and the rare internal single-delete.
 * Every mutation still fires `onSpliced` from the live path only (replay rebuilds
 * the Model silently and never invokes these methods), so existing subscribers
 * (micro-compaction, context-injector, task-notification) observe the same
 * splice-shaped change events regardless of which 1.4 Op was persisted. Message
 * ids are stamped at the dispatch call site so `apply` stays pure. Blob
 * dehydrate/rehydrate is declared on `ContextModel.blobs`. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event';
import { IAgentWireService, type IWireService } from '#/wire';

import { IAgentContextMemoryService, type ContextCompactionInput } from './contextMemory';
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

declare module '#/agent/wireRecord' {
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
    this.wire.dispatch(contextClear({}));
    this.eventBus.publish({ type: 'context.spliced', start: 0, deleteCount, messages: [] });
  }

  undo(count: number): UndoCut {
    const history = this.get();
    const cut = computeUndoCut(history, count);
    if (cut.cutIndex >= 0 && cut.removedCount >= count) {
      this.wire.dispatch(contextUndo({ count }));
      this.eventBus.publish({ type: 'context.spliced',
        start: cut.cutIndex,
        deleteCount: history.length - cut.cutIndex,
        messages: [],
      });
    }
    return cut;
  }

  applyCompaction(input: ContextCompactionInput): void {
    const summary = ensureMessageId(input.summary);
    this.wire.dispatch(contextApplyCompaction({ count: input.count, summary }));
    this.eventBus.publish({ type: 'context.spliced',
      start: 0,
      deleteCount: input.count,
      messages: [summary],
      tokens: input.tokens,
    });
  }

  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void {
    const stamped = messages.map(ensureMessageId);
    this.wire.dispatch(contextSplice({ start, deleteCount, messages: stamped, tokens }));
    this.eventBus.publish({ type: 'context.spliced',
      start,
      deleteCount,
      messages: [...stamped],
      tokens,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  InstantiationType.Delayed,
  'contextMemory',
);
