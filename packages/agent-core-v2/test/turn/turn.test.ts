import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory } from '#/contextMemory';
import { IEventBus } from '#/eventBus';
import { IExternalHooksService } from '#/externalHooks';
import { ILoopService } from '#/loop';
import { IPlanService } from '#/plan';
import { ITelemetryService } from '#/telemetry';
import { ITurnService } from '#/turn';
import type { Turn } from '#/turn';
import { TurnService } from '#/turn/turnService';
import { IUsageService } from '#/usage';
import { IWireRecord } from '#/wireRecord';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';

describe('TurnService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());

    // Real in-memory collaborators shared with other domain tests.
    ix.set(IWireRecord, stubWireRecord());
    ix.set(IContextMemory, stubContextMemory());

    // No-op collaborators — only the members exercised by TurnService.
    ix.stub(IUsageService, { beginTurn() {}, endTurn() {} });
    ix.stub(IEventBus, { emit() {}, on: () => ({ dispose() {} }) });
    ix.stub(IExternalHooksService, { triggerInterrupt() {} });
    ix.stub(ITelemetryService, { track() {} });
    // TurnService.telemetryMode() resolves IPlanService via IInstantiationService.
    ix.stub(IPlanService, { isActive: false });

    // Default loop completes immediately; the cancel test overrides this below.
    ix.set(ILoopService, { runTurn: async () => ({ reason: 'completed' }) });

    // System under test, registered by interface.
    ix.set(ITurnService, new SyncDescriptor(TurnService));
  });
  afterEach(() => disposables.dispose());

  it('launch returns a turn, fires onLaunched, and tracks active state until completion', async () => {
    const svc = ix.get(ITurnService);
    const launched: number[] = [];
    const ended: string[] = [];
    svc.hooks.onLaunched.register('test', ({ turn }) => {
      launched.push(turn.id);
    });
    svc.hooks.onEnded.register('test', ({ result }) => {
      ended.push(result.reason);
    });

    expect(svc.getActiveTurn()).toBeUndefined();

    // Non-user origin so the user-prompt hook path is skipped.
    const turn = svc.launch({ kind: 'retry' });
    expect(turn.id).toBe(0);
    expect(launched).toEqual([0]);
    expect(svc.getActiveTurn()).toBe(turn);

    const result = await turn.result;
    expect(result.reason).toBe('completed');
    expect(svc.getActiveTurn()).toBeUndefined();
    expect(ended).toEqual(['completed']);
  });

  it('cancel aborts the active turn and clears active state', async () => {
    // Resolve with 'cancelled' once the turn's abort signal fires, so the
    // turn stays active until cancel() is called.
    ix.set(ILoopService, {
      runTurn: (turn: Turn) =>
        new Promise((resolve) => {
          const { signal } = turn.abortController;
          if (signal.aborted) {
            resolve({ reason: 'cancelled' });
            return;
          }
          signal.addEventListener('abort', () => resolve({ reason: 'cancelled' }), { once: true });
        }),
    });

    const svc = ix.get(ITurnService);
    const turn = svc.launch({ kind: 'retry' });
    expect(svc.getActiveTurn()).toBe(turn);

    svc.cancel();
    const result = await turn.result;
    expect(result.reason).toBe('cancelled');
    expect(svc.getActiveTurn()).toBeUndefined();
  });
});
