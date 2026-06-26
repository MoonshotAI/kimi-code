import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore, toDisposable } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IBackgroundService, type BackgroundTask } from '#/background';
import { BackgroundService } from '#/background/backgroundService';
import { IContextMemory } from '#/contextMemory';
import { IEventBus } from '#/eventBus';
import { IExternalHooksService } from '#/externalHooks';
import { IPromptService } from '#/prompt';
import { ITelemetryService } from '#/telemetry';
import { IWireRecord } from '#/wireRecord';

import { stubContextMemory, stubWireRecord } from '../contextMemory/stubs';

function fakeProcessTask(): BackgroundTask {
  return {
    idPrefix: 'test',
    kind: 'process',
    description: 'fake process task',
    start: () => {},
    toInfo: (base) => ({ ...base, kind: 'process', command: 'echo', pid: 0, exitCode: null }),
  };
}

describe('BackgroundService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IContextMemory, stubContextMemory());
    ix.stub(IEventBus, { emit: () => {}, on: () => toDisposable(() => {}) });
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IPromptService, { steer: () => undefined });
    ix.stub(IExternalHooksService, { triggerNotification: () => {} });
    ix.set(IBackgroundService, new SyncDescriptor(BackgroundService));
  });
  afterEach(() => disposables.dispose());

  it('registerTask / list / readOutput / stop', async () => {
    const svc = ix.get(IBackgroundService);
    const id = svc.registerTask(fakeProcessTask());
    const listed = svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.taskId).toBe(id);
    expect(listed[0]?.kind).toBe('process');
    expect(await svc.readOutput(id)).toBe('');
    await svc.stop(id);
  });
});
