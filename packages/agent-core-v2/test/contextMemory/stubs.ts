/**
 * `contextMemory` test stubs — shared doubles for `IContextMemory` and its
 * collaborators (`IWireRecord`, `IReplayBuilderService`).
 *
 * Lives under `test/` (not `src/`) so test-support code stays out of the
 * production tree. Import from a relative path (`./stubs` or
 * `../contextMemory/stubs`).
 */

import { toDisposable } from '#/_base/di';
import type { ServiceRegistration } from '#/_base/di/test';
import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import { IContextMemory, type ContextMessage } from '#/contextMemory';
import { IReplayBuilderService } from '#/replayBuilder';
import { IWireRecord } from '#/wireRecord';

/**
 * A no-op `IWireRecord`. `register` returns a disposable so services that
 * `_register(wireRecord.register(...))` in their constructor can be disposed
 * cleanly; `append` is a no-op (in-memory history is driven by `applySplice`).
 */
export function stubWireRecord(): IWireRecord {
  const hooks = createHooks(['onRestoredRecord', 'onResumeEnded']) as IWireRecord['hooks'];
  return {
    restoring: null,
    postRestoring: false,
    hooks,
    append: () => {},
    register: () => toDisposable(() => {}),
    restore: () => Promise.resolve({}),
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

/** A no-op `IReplayBuilderService` — every mutator is a no-op. */
export function stubReplayBuilder(): IReplayBuilderService {
  return {
    _serviceBrand: undefined,
    postRestoring: false,
    captureLiveRecords: false,
    push: () => {},
    patchLast: () => {},
    removeLastMessages: () => {},
    finishRestoringRecord: () => false,
    buildResult: () => [],
  };
}

export interface StubContextMemory extends IContextMemory {
  /** The live backing history, exposed so tests can inspect splices. */
  readonly messages: readonly ContextMessage[];
}

/**
 * An in-memory `IContextMemory`. `spliceHistory` mutates the backing history
 * and fires `onSpliced`, mirroring `ContextMemoryService.applySplice` enough
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
    hooks,
    get messages() {
      return messages;
    },
    getHistory: () => [...messages],
    spliceHistory: (start, deleteCount, inserted, tokens) => {
      messages.splice(start, deleteCount, ...inserted);
      void hooks.onSpliced.run({
        start,
        deleteCount,
        messages: [...inserted],
        tokens,
      });
    },
  };
}

/**
 * Register the default collaborators consumed by `ContextMemoryService`
 * (`IWireRecord`, `IReplayBuilderService`) and an in-memory `IContextMemory`.
 * Tests that exercise the real `ContextMemoryService` should override
 * `IContextMemory` via `additionalServices`.
 */
export function registerContextMemoryServices(reg: ServiceRegistration): void {
  reg.defineInstance(IWireRecord, stubWireRecord());
  reg.defineInstance(IReplayBuilderService, stubReplayBuilder());
  reg.defineInstance(IContextMemory, stubContextMemory());
}
