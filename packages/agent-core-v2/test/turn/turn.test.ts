import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { ILoopRunner, ITurnEvents } from '#/turn/turn';
import { IUsageService } from '#/usage/usage';

import { LoopRunner } from '#/turn/loopRunner';
import { TurnEvents } from '#/turn/turnEvents';
import { TurnService } from '#/turn/turnService';
import { registerAgentLifecycleServices } from '../agent-lifecycle/stubs';
import { registerContextServices } from '../context/stubs';
import { registerInjectionServices } from '../injection/stubs';
import { registerKosongServices } from '../kosong/stubs';
import { registerLogServices } from '../log/stubs';
import { registerPermissionServices } from '../permission/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';

describe('TurnService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerLogServices,
        registerTelemetryServices,
        registerAgentLifecycleServices,
        registerPermissionServices,
        registerContextServices,
        registerInjectionServices,
        registerKosongServices,
      ],
      additionalServices: (reg) => {
        reg.defineInstance(ITurnEvents, new TurnEvents());
        reg.definePartialInstance(IUsageService, {});
        reg.defineInstance(ILoopRunner, new LoopRunner());
      },
    });
  });
  afterEach(() => disposables.dispose());

  // NOTE: TurnService is constructed directly (not resolved by interface)
  // because the 'cancel' test needs two independent instances with different
  // ILoopRunner registrations — a singleton-per-container resolution cannot
  // produce both. See di-testing.md "Exceptions".
  function make(): TurnService {
    return ix.createInstance(TurnService);
  }

  it('launch emits start → step → end and tracks active state', async () => {
    const svc = make();
    const events: string[] = [];
    svc.onWillStartTurn((e) => events.push(`start:${e.turnId}`));
    svc.onDidEndStep((e) => events.push(`step:${e.step}`));
    svc.onDidEndTurn((e) => events.push(`end:${e.reason}`));

    expect(svc.hasActiveTurn).toBe(false);
    await svc.prompt('hello');
    expect(svc.hasActiveTurn).toBe(false);
    expect(events).toEqual(['start:turn-0', 'step:0', 'end:completed']);
  });

  it('steer buffers input', () => {
    const svc = make();
    svc.steer('a');
    svc.steer('b', 'user');
    expect(svc.hasActiveTurn).toBe(false);
  });

  it('cancel fires onDidEndTurn with cancelled reason', async () => {
    const svc = make();
    const ends: string[] = [];
    svc.onDidEndTurn((e) => ends.push(e.reason));
    const slow = new (class extends LoopRunner {
      override run(): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, 10));
      }
    })();
    ix.set(ILoopRunner, slow);
    const svc2 = ix.createInstance(TurnService);
    svc2.onDidEndTurn((e) => ends.push(e.reason));
    const p = svc2.prompt('hello');
    expect(svc2.hasActiveTurn).toBe(true);
    svc2.cancel('user');
    await p;
    expect(ends).toContain('user');
  });
});
