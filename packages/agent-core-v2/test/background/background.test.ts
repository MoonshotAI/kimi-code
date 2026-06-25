import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IBackgroundService } from '#/background/background';
import { IKaosService } from '#/kaos/kaos';

import { BackgroundService } from '#/background/backgroundService';
import { registerAgentLifecycleServices } from '../agent-lifecycle/stubs';
import { registerLogServices } from '../log/stubs';
import { registerRecordsServices } from '../records/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';

describe('BackgroundService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerLogServices,
        registerTelemetryServices,
        registerRecordsServices,
        registerAgentLifecycleServices,
      ],
      additionalServices: (reg) => {
        reg.definePartialInstance(IKaosService, {});
        reg.define(IBackgroundService, BackgroundService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('start / list / stop / getOutput', async () => {
    const svc = ix.get(IBackgroundService);
    const id = await svc.start({ id: 'x', kind: 'process' });
    expect(svc.list()).toEqual([{ id: 'x', kind: 'process' }]);
    expect(await svc.getOutput(id)).toBe('');
    await svc.stop(id);
  });
});
