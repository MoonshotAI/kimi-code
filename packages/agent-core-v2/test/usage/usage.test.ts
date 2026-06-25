import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IUsageService } from '#/usage/usage';
import { UsageService } from '#/usage/usageService';
import { registerRecordsServices } from '../records/stubs';
import { registerTelemetryServices } from '../telemetry/stubs';

describe('UsageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerTelemetryServices, registerRecordsServices],
      additionalServices: (reg) => {
        reg.define(IUsageService, UsageService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('accumulates input/output tokens', () => {
    const svc = ix.get(IUsageService);
    svc.record(10, 5);
    svc.record(3, 2);
    expect(svc.totals).toEqual({ inputTokens: 13, outputTokens: 7 });
  });
});
