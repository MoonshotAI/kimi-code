import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Event } from '#/_base/event';
import {
  ITurnService,
  type TurnEndEvent,
  type TurnStartEvent,
  type TurnStepEvent,
  type TurnToolEvent,
} from '#/turn/turn';

import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/config/config';
import { ILogService } from '#/log/log';
import { IAgentRecords } from '#/records/records';
import { ISkillRegistry } from '#/skill/skill';

import { SkillRegistry, SkillService } from '#/skill/skillService';

const noneEvent = (<T>(): Event<T> => () => ({ dispose: () => {} }))();

class StubTurn implements ITurnService {
  readonly _serviceBrand: undefined;
  readonly onWillStartTurn = noneEvent as Event<TurnStartEvent>;
  readonly onWillExecuteTool = noneEvent as Event<TurnToolEvent>;
  readonly onDidFinalizeTool = noneEvent as Event<TurnToolEvent>;
  readonly onDidEndStep = noneEvent as Event<TurnStepEvent>;
  readonly onDidEndTurn = noneEvent as Event<TurnEndEvent>;
  readonly prompts: string[] = [];
  get hasActiveTurn(): boolean {
    return false;
  }
  get currentId(): string | undefined {
    return undefined;
  }
  prompt(input: string): Promise<void> {
    this.prompts.push(input);
    return Promise.resolve();
  }
  steer(): void {}
  retry(): Promise<void> {
    return Promise.resolve();
  }
  cancel(): void {}
}

describe('SkillRegistry', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, {});
    ix.stub(ILogService, {});
  });
  afterEach(() => disposables.dispose());

  it('register / get / list', async () => {
    const reg = ix.createInstance(SkillRegistry);
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
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IConfigService, {});
    ix.stub(ILogService, {});
    ix.stub(IAgentRecords, {});
  });
  afterEach(() => disposables.dispose());

  it('activate prompts the turn for a known skill', async () => {
    const reg = ix.createInstance(SkillRegistry);
    reg.register({ name: 'commit', root: '/skills/commit' });
    ix.set(ISkillRegistry, reg);
    const turn = new StubTurn();
    ix.set(ITurnService, turn);
    const svc = ix.createInstance(SkillService);
    await svc.activate('commit');
    expect(turn.prompts).toEqual(['Activate skill: commit']);
  });

  it('activate throws for unknown skill', async () => {
    const reg = ix.createInstance(SkillRegistry);
    ix.set(ISkillRegistry, reg);
    const turn = new StubTurn();
    ix.set(ITurnService, turn);
    const svc = ix.createInstance(SkillService);
    await expect(svc.activate('missing')).rejects.toThrow(/unknown skill/);
  });
});
