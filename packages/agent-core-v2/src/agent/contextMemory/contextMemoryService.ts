/**
 * `contextMemory` domain (L4) — `IAgentContextMemoryService` implementation.
 *
 * Owns the per-agent conversation history in the wire `ContextModel`
 * (`ContextMessage[]`): reads through `wire.getModel`, writes through the
 * v1 wire Ops (`append` / `appendLoopEvent` / `clear` / `applyCompaction`).
 * (Undo no longer flows through here: the `rewind` domain cuts the journal
 * with a `log.cut` control record and the wire rebuilds this Model.)
 * As the sole live mutation gateway for the history, it also cascades a
 * (non-persisted) `context_size.measured` Op alongside every mutation that
 * changes the measured prefix — `clear` resets it and `applyCompaction`
 * adopts `tokensAfter`; `append` leaves the measured prefix untouched since
 * new messages are the unmeasured tail (see `contextSizeService`).
 * Splice-shaped mutations publish `context.spliced` from the live path only
 * (replay rebuilds the Model silently and never invokes these methods), so
 * existing subscribers observe the same change regardless of which Op was
 * persisted. Messages
 * are persisted without local ids — the on-disk record matches v1's field set
 * and public message ids are derived from the transcript index. Blob
 * dehydrate/rehydrate is declared on `ContextModel.blobs`. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { contextSizeMeasured } from '#/agent/contextSize/contextSizeOps';
import { IWireService } from '#/wire/wire';

import {
  IAgentContextMemoryService,
  type ContextCompactionInput,
  type ContextCompactionResult,
} from './contextMemory';
import { buildContextCompactionShape } from './compactionHandoff';
import {
  ContextModel,
  contextAppendLoopEvent,
  contextAppendMessage,
  contextApplyCompaction,
  contextClear,
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
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentContextMemoryService,
  AgentContextMemoryService,
  InstantiationType.Eager,
  'contextMemory',
);
