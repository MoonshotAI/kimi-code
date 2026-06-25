import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IContextService } from '#/context/context';
import { ContextService } from '#/context/contextService';
import { IInjectionService } from '#/injection/injection';
import { InjectionService } from '#/injection/injectionService';
import { IAgentKaos } from '#/kaos/kaos';
import { IPlanService } from '#/plan/plan';
import { PlanService } from '#/plan/planService';
import { ITurnService } from '#/turn/turn';
import { registerConfigServices } from '../config/stubs';
import { registerRecordsServices } from '../records/stubs';
import { registerTurnServices } from '../turn/stubs';

describe('PlanService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerRecordsServices, registerConfigServices, registerTurnServices],
      additionalServices: (reg) => {
        reg.definePartialInstance(IAgentKaos, {});
        reg.define(IContextService, ContextService);
        reg.define(IInjectionService, InjectionService);
        reg.define(IPlanService, PlanService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('enter sets active and pushes a plan injection', async () => {
    const plan = ix.get(IPlanService);
    const injection = ix.get(IInjectionService);
    expect(plan.active).toBe(false);
    await plan.enter();
    expect(plan.active).toBe(true);
    expect(injection.flush()).toEqual([
      { kind: 'plan', content: 'Plan mode active — propose a plan before acting.' },
    ]);
    plan.cancel();
    expect(plan.active).toBe(false);
  });

  it('resets active on turn end', async () => {
    const plan = ix.get(IPlanService);
    const turn = ix.get(ITurnService);
    await plan.enter();
    await turn.prompt('go');
    expect(plan.active).toBe(false);
  });
});
