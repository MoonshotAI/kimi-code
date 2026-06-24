import { describe, expect, it } from 'vitest';

import type { Event } from '#/_base/event';
import type {
  ITurnService,
  TurnEndEvent,
  TurnStartEvent,
  TurnStepEvent,
  TurnToolEvent,
} from '#/turn/turn';

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
  it('register / get / list', async () => {
    const reg = new SkillRegistry(undefined as never, undefined as never);
    reg.register({ name: 'commit', root: '/skills/commit' });
    expect(reg.get('commit')).toEqual({ name: 'commit', root: '/skills/commit' });
    expect(reg.list()).toHaveLength(1);
    await reg.loadRoots(['/skills']);
  });
});

describe('SkillService', () => {
  it('activate prompts the turn for a known skill', async () => {
    const reg = new SkillRegistry(undefined as never, undefined as never);
    reg.register({ name: 'commit', root: '/skills/commit' });
    const turn = new StubTurn();
    const svc = new SkillService(reg, undefined as never, turn);
    await svc.activate('commit');
    expect(turn.prompts).toEqual(['Activate skill: commit']);
  });

  it('activate throws for unknown skill', async () => {
    const reg = new SkillRegistry(undefined as never, undefined as never);
    const turn = new StubTurn();
    const svc = new SkillService(reg, undefined as never, turn);
    await expect(svc.activate('missing')).rejects.toThrow(/unknown skill/);
  });
});
