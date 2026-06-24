import { describe, expect, it } from 'vitest';

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
  it('create / update / clear track current goal', () => {
    const goal = new GoalService(undefined as never, makeTurn(), undefined as never);
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
