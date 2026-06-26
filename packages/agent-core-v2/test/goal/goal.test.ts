import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IInjectionService } from '#/injection/injection';
import { IAgentRecords } from '#/records/records';
import { ITurnService } from '#/turn/turn';
import { LoopRunner } from '#/turn/loopRunner';
import { TurnService } from '#/turn/turnService';

import { GoalService } from '#/goal/goalService';

function makeTurn(): TurnService {
  return new TurnService(
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    new LoopRunner(),
  );
}

describe('GoalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentRecords, {});
    ix.set(ITurnService, makeTurn());
    ix.stub(IInjectionService, {});
  });
  afterEach(() => disposables.dispose());

  it('create / update / clear track current goal', () => {
    const goal = disposables.add(ix.createInstance(GoalService));
    expect(goal.current).toBeUndefined();
    goal.create('build it');
    expect(goal.current).toEqual({ objective: 'build it', status: 'active' });
    goal.update({ status: 'done' });
    expect(goal.current?.status).toBe('done');
    goal.clear();
    expect(goal.current).toBeUndefined();
    goal.dispose();
  });
});
