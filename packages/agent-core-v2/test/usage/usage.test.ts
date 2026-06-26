import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/eventBus';
import { IUsageService } from '#/usage';
import { UsageService } from '#/usage/usageService';
import { IWireRecord } from '#/wireRecord';

import { stubWireRecord } from '../contextMemory/stubs';

describe('UsageService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IEventBus, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.set(IUsageService, new SyncDescriptor(UsageService));
  });
  afterEach(() => disposables.dispose());

  it('accumulates input/output tokens per model', () => {
    const svc = ix.get(IUsageService);
    svc.record('m', { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 });
    svc.record('m', { inputOther: 3, output: 2, inputCacheRead: 0, inputCacheCreation: 0 });
    expect(svc.data().byModel?.['m']).toEqual({
      inputOther: 13,
      output: 7,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(svc.data().total).toEqual({
      inputOther: 13,
      output: 7,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
  });
});
