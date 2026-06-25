import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IGoalService } from '#/goal/goal';

import { GoalService } from '#/goal/goalService';
import { registerInjectionServices } from '../injection/stubs';
import { registerRecordsServices } from '../records/stubs';
import { registerTurnServices } from '../turn/stubs';

describe('GoalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerRecordsServices, registerTurnServices, registerInjectionServices],
      additionalServices: (reg) => {
        reg.define(IGoalService, GoalService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('create / update / clear track current goal', () => {
    const goal = ix.get(IGoalService);
    expect(goal.current).toBeUndefined();
    goal.create('build it');
    expect(goal.current).toEqual({ objective: 'build it', status: 'active' });
    goal.update({ status: 'done' });
    expect(goal.current?.status).toBe('done');
    goal.clear();
    expect(goal.current).toBeUndefined();
  });
});
