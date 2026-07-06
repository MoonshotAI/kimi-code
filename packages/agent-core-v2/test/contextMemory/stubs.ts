/**
 * `contextMemory` test stubs — shared doubles for `IAgentContextMemoryService` and its
 * collaborator (`IAgentWireRecordService`).
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../contextMemory/stubs`).
 */

import { toDisposable } from '#/_base/di';
import type { ServiceRegistration } from '#/_base/di/test';
import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import { ensureMessageId, IAgentContextMemoryService, type ContextMessage } from '#/agent/contextMemory';
import { IAgentWireRecordService } from '#/agent/wireRecord';

/**
 * A no-op `IAgentWireRecordService`. `register` returns a disposable so services that
 * `_register(wireRecord.register(...))` in their constructor can be disposed
 * cleanly; `append` is a no-op (in-memory history is driven by `applySplice`).
 */
export function stubWireRecord(): IAgentWireRecordService {
  const hooks = createHooks(['onRestoredRecord', 'onResumeEnded']) as IAgentWireRecordService['hooks'];
  return {
    _serviceBrand: undefined,
    restoring: null,
    postRestoring: false,
    hooks,
    append: () => {},
    register: () => toDisposable(() => {}),
    restore: () => Promise.resolve({}),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
    getRecords: () => [],
  };
}

export interface StubContextMemory extends IAgentContextMemoryService {
  /** The live backing history, exposed so tests can inspect splices. */
  readonly messages: readonly ContextMessage[];
}

/**
 * An in-memory `IAgentContextMemoryService`. `spliceHistory` mutates the backing history
 * and fires `onSpliced`, mirroring `AgentContextMemoryService.applySplice` enough
 * for collaborators (e.g. `DynamicInjectorService`) to react to splices.
 */
export function stubContextMemory(): StubContextMemory {
  const messages: ContextMessage[] = [];
  const hooks = {
    onSpliced: createHooks(['onSpliced'])['onSpliced'],
  } as unknown as Hooks<{
    onSpliced: {
      start: number;
      deleteCount: number;
      messages: ContextMessage[];
      tokens?: number;
    };
  }>;
  return {
    _serviceBrand: undefined,
    hooks,
    get messages() {
      return messages;
    },
    get: () => [...messages],
    splice: (start, deleteCount, inserted, tokens) => {
      const stamped = inserted.map(ensureMessageId);
      messages.splice(start, deleteCount, ...stamped);
      void hooks.onSpliced.run({
        start,
        deleteCount,
        messages: [...stamped],
        tokens,
      });
    },
  };
}

/**
 * Register the default collaborators consumed by `AgentContextMemoryService`
 * (`IAgentWireRecordService`) and an in-memory `IAgentContextMemoryService`.
 * Tests that exercise the real `AgentContextMemoryService` should override
 * `IAgentContextMemoryService` via `additionalServices`.
 */
export function registerContextMemoryServices(reg: ServiceRegistration): void {
  reg.defineInstance(IAgentWireRecordService, stubWireRecord());
  reg.defineInstance(IAgentContextMemoryService, stubContextMemory());
}
