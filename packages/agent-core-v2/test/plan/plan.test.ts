import { describe, expect, it } from 'vitest';

import { ContextService } from '#/context/contextService';
import { InjectionService } from '#/injection/injectionService';
import { LoopRunner } from '#/turn/loopRunner';
import { TurnService } from '#/turn/turnService';

import { PlanService } from '#/plan/planService';

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

describe('PlanService', () => {
  it('enter sets active and pushes a plan injection', async () => {
    const ctx = new ContextService(undefined as never);
    const injection = new InjectionService(ctx);
    const turn = makeTurn();
    const plan = new PlanService(
      undefined as never,
      undefined as never,
      undefined as never,
      injection,
      turn,
    );
    expect(plan.active).toBe(false);
    await plan.enter();
    expect(plan.active).toBe(true);
    expect(injection.flush()).toEqual([
      { kind: 'plan', content: 'Plan mode active — propose a plan before acting.' },
    ]);
    plan.cancel();
    expect(plan.active).toBe(false);
    plan.dispose();
  });

  it('resets active on turn end', async () => {
    const ctx = new ContextService(undefined as never);
    const injection = new InjectionService(ctx);
    const turn = makeTurn();
    const plan = new PlanService(undefined as never, undefined as never, undefined as never, injection, turn);
    await plan.enter();
    await turn.prompt('go');
    expect(plan.active).toBe(false);
    plan.dispose();
  });
});
