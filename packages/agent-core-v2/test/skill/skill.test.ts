import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { ISkillRegistry, ISkillService } from '#/skill/skill';
import { ITurnService } from '#/turn/turn';
import { stubTurn } from '../turn/stubs';

import { SkillRegistry, SkillService } from '#/skill/skillService';
import { registerConfigServices } from '../config/stubs';
import { registerLogServices } from '../log/stubs';
import { registerRecordsServices } from '../records/stubs';

describe('SkillRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [registerConfigServices, registerLogServices],
      additionalServices: (reg) => {
        reg.define(ISkillRegistry, SkillRegistry);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('register / get / list', async () => {
    const reg = ix.get(ISkillRegistry);
    reg.register({ name: 'commit', root: '/skills/commit' });
    expect(reg.get('commit')).toEqual({ name: 'commit', root: '/skills/commit' });
    expect(reg.list()).toHaveLength(1);
    await reg.loadRoots(['/skills']);
  });
});

describe('SkillService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      base: [
        registerConfigServices,
        registerLogServices,
        registerRecordsServices,
      ],
      additionalServices: (reg) => {
        reg.define(ISkillRegistry, SkillRegistry);
        reg.define(ISkillService, SkillService);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('activate prompts the turn for a known skill', async () => {
    const reg = ix.get(ISkillRegistry);
    reg.register({ name: 'commit', root: '/skills/commit' });
    const turn = stubTurn();
    ix.set(ITurnService, turn);
    const svc = ix.get(ISkillService);
    await svc.activate('commit');
    expect(turn.prompts).toEqual(['Activate skill: commit']);
  });

  it('activate throws for unknown skill', async () => {
    const turn = stubTurn();
    ix.set(ITurnService, turn);
    const svc = ix.get(ISkillService);
    await expect(svc.activate('missing')).rejects.toThrow(/unknown skill/);
  });
});
