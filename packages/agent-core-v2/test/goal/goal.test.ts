import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IContextMemory } from '#/contextMemory';
import { IDynamicInjector } from '#/dynamicInjector';
import { IEventBus } from '#/eventBus';
import { IGoalService } from '#/goal';
import { GoalService } from '#/goal/goalService';
import { IReplayBuilderService } from '#/replayBuilder';
import { ITelemetryService } from '#/telemetry';
import { IWireRecord } from '#/wireRecord';
import {
  stubContextMemory,
  stubReplayBuilder,
  stubWireRecord,
} from '../contextMemory/stubs';

describe('GoalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(IEventBus, { emit: () => {}, on: () => ({ dispose: () => {} }) });
    ix.stub(IContextMemory, stubContextMemory());
    ix.stub(IReplayBuilderService, stubReplayBuilder());
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IDynamicInjector, { register: () => ({ dispose: () => {} }) });
    ix.set(IGoalService, new SyncDescriptor(GoalService, [{}]));
  });
  afterEach(() => disposables.dispose());

  it('starts with no current goal', () => {
    const goal = ix.get(IGoalService);
    expect(goal.getGoal()).toEqual({ goal: null });
  });

  it('createGoal tracks an active goal', async () => {
    const goal = ix.get(IGoalService);
    const snapshot = await goal.createGoal({ objective: 'build it' });

    expect(snapshot.objective).toBe('build it');
    expect(snapshot.status).toBe('active');
    expect(goal.getGoal().goal).toMatchObject({
      objective: 'build it',
      status: 'active',
    });
  });

  it('pauseGoal changes status to paused', async () => {
    const goal = ix.get(IGoalService);
    await goal.createGoal({ objective: 'build it' });

    const paused = await goal.pauseGoal();
    expect(paused.status).toBe('paused');
    expect(goal.getGoal().goal?.status).toBe('paused');
  });

  it('cancelGoal clears the current goal', async () => {
    const goal = ix.get(IGoalService);
    await goal.createGoal({ objective: 'build it' });

    await goal.cancelGoal();
    expect(goal.getGoal()).toEqual({ goal: null });
  });
});
