import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentRecords } from '#/records/records';
import { ITelemetryService } from '#/telemetry/telemetry';
import { UsageService } from '#/usage/usageService';

describe('UsageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, { _serviceBrand: undefined });
    ix.stub(ITelemetryService, { _serviceBrand: undefined });
  });
  afterEach(() => disposables.dispose());

  it('accumulates input/output tokens', () => {
    const svc = disposables.add(ix.createInstance(UsageService));
    svc.record(10, 5);
    svc.record(3, 2);
    expect(svc.totals).toEqual({ inputTokens: 13, outputTokens: 7 });
  });
});
