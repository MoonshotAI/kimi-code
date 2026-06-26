import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory } from '#/contextMemory';
import { IDynamicInjector } from '#/dynamicInjector';
import { IEventBus } from '#/eventBus';
import { IKaosService } from '#/kaos';
import { IPlanService } from '#/plan';
import { PlanService } from '#/plan/planService';
import { IProfileService } from '#/profile';
import { IReplayBuilderService } from '#/replayBuilder';
import { ITelemetryService } from '#/telemetry';
import { IToolRegistry } from '#/toolRegistry';
import { IWireRecord } from '#/wireRecord';

import {
  stubContextMemory,
  stubReplayBuilder,
  stubWireRecord,
} from '../contextMemory/stubs';

describe('PlanService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());

    // Real in-memory collaborators shared with other domain tests.
    ix.set(IWireRecord, stubWireRecord());
    ix.set(IContextMemory, stubContextMemory());
    ix.set(IReplayBuilderService, stubReplayBuilder());

    // No-op collaborators — only the members exercised by PlanService.
    ix.stub(IEventBus, { emit() {} });
    ix.stub(ITelemetryService, { track() {} });
    ix.stub(IToolRegistry, { register: () => ({ dispose() {} }) });
    ix.stub(IDynamicInjector, { register: () => ({ dispose() {} }) });
    // kaos undefined → filesystem access short-circuits via optional chaining.
    ix.stub(IKaosService, { kaos: undefined });
    // PlanService.currentCwd() reads profile.data().cwd.
    ix.stub(IProfileService, 'data', () => ({ cwd: '/tmp' }));

    // System under test, registered by interface.
    ix.set(IPlanService, new SyncDescriptor(PlanService));
  });
  afterEach(() => disposables.dispose());

  it('enter activates plan mode and cancel deactivates it', async () => {
    const plan = ix.get(IPlanService);

    expect(plan.isActive).toBe(false);
    expect(plan.planFilePath).toBeNull();

    await plan.enter();
    expect(plan.isActive).toBe(true);
    expect(plan.planFilePath).not.toBeNull();

    plan.cancel();
    expect(plan.isActive).toBe(false);
    expect(plan.planFilePath).toBeNull();
  });

  it('exit deactivates plan mode', async () => {
    const plan = ix.get(IPlanService);

    await plan.enter();
    expect(plan.isActive).toBe(true);

    plan.exit();
    expect(plan.isActive).toBe(false);
    expect(plan.planFilePath).toBeNull();
  });

  it('enter throws when plan mode is already active', async () => {
    const plan = ix.get(IPlanService);

    await plan.enter();
    await expect(plan.enter()).rejects.toThrow('Already in plan mode');
  });
});
