/**
 * `contextMemory` domain (L4) — `IAgentContextMemoryService` implementation.
 *
 * Owns the per-agent conversation history in the wire `ContextModel`
 * (`ContextMessage[]`): reads through `wire.getModel`, writes through
 * `wire.dispatch(contextSplice(...))` (splice is the single primitive). The
 * `context.splice` record still rides the shared wire log read by `getRecords()`
 * and replayed into the Model, so its shape stays declared in `WireRecordMap`;
 * blob offload now lives in the `WireService` hook (seeded with
 * `contextBlobSelector`) rather than a `record.define(..., { blobs })` facet.
 * Message ids are stamped at the dispatch call site so `apply` stays pure.
 * `onSpliced` fires from the live `splice` path only — replay rebuilds the Model
 * silently and never invokes the service method, so the hook is quiet on
 * restore. The legacy replay read model (`IAgentRecordService`) is no longer
 * mirrored here. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { OrderedHookSlot } from '#/hooks';
import { IAgentWireService, type IWireService } from '#/wire';

import { IAgentContextMemoryService } from './contextMemory';
import { ContextModel, contextSplice } from './contextOps';
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

export class AgentContextMemoryService extends Disposable implements IAgentContextMemoryService {
  declare readonly _serviceBrand: undefined;

  readonly hooks = {
    onSpliced: new OrderedHookSlot<{
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    }>(),
  };

  constructor(@IAgentWireService private readonly wire: IWireService) {
    super();
  }

  get(): readonly ContextMessage[] {
    return this.wire.getModel(ContextModel) as readonly ContextMessage[];
  }

  splice(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    tokens?: number,
  ): void {
    const stamped = messages.map(ensureMessageId);
    this.wire.dispatch(contextSplice({ start, deleteCount, messages: stamped, tokens }));
    void this.hooks.onSpliced.run({
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
