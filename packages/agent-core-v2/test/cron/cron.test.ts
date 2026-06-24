import { describe, expect, it } from 'vitest';

import type { Event } from '#/_base/event';
import type { ServicesAccessor } from '#/_base/di/instantiation';
import type { IScopeHandle } from '#/_base/di/scope';
import type { IAgentLifecycleService } from '#/agent-lifecycle/agentLifecycle';
import type { ISessionActivity } from '#/session-activity/sessionActivity';
import type {
  ITurnService,
  TurnEndEvent,
  TurnStartEvent,
  TurnStepEvent,
  TurnToolEvent,
} from '#/turn/turn';

import { CronFireCoordinator, CronService } from '#/cron/cronService';

const noneEvent = (<T>(): Event<T> => () => ({ dispose: () => {} }))();

class StubTurn implements ITurnService {
  readonly _serviceBrand: undefined;
  readonly onWillStartTurn = noneEvent as Event<TurnStartEvent>;
  readonly onWillExecuteTool = noneEvent as Event<TurnToolEvent>;
  readonly onDidFinalizeTool = noneEvent as Event<TurnToolEvent>;
  readonly onDidEndStep = noneEvent as Event<TurnStepEvent>;
  readonly onDidEndTurn = noneEvent as Event<TurnEndEvent>;
  readonly steered: string[] = [];
  get hasActiveTurn(): boolean {
    return false;
  }
  get currentId(): string | undefined {
    return undefined;
  }
  prompt(): Promise<void> {
    return Promise.resolve();
  }
  steer(content: string): void {
    this.steered.push(content);
  }
  retry(): Promise<void> {
    return Promise.resolve();
  }
  cancel(): void {}
}

function activity(idle: boolean): ISessionActivity {
  return { _serviceBrand: undefined, isIdle: () => idle };
}

describe('CronService', () => {
  it('create / list / delete', async () => {
    const svc = new CronService(
      undefined as never,
      activity(true),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const id = await svc.create({ id: '', cron: '1000', prompt: 'hi', recurring: false });
    expect(svc.list()).toHaveLength(1);
    await svc.delete(id);
    expect(svc.list()).toEqual([]);
    svc.dispose();
  });

  it('tick fires due tasks only when idle', async () => {
    const svc = new CronService(
      undefined as never,
      activity(false),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const fired: string[] = [];
    svc.onDidFire((e) => fired.push(e.content));
    await svc.create({ id: 'a', cron: '1000', prompt: 'fire-me', recurring: false });
    svc.tick(Date.now() + 500); // not idle → no fire (also not yet due)
    expect(fired).toEqual([]);
    (svc as unknown as { activity: ISessionActivity }).activity = activity(true);
    svc.tick(Date.now() + 2000); // idle + due → fire
    expect(fired).toEqual(['fire-me']);
    svc.dispose();
  });

  it('one-shot tasks are removed after firing', async () => {
    const svc = new CronService(
      undefined as never,
      activity(true),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    await svc.create({ id: 'a', cron: '1000', prompt: 'x', recurring: false });
    svc.tick(Date.now() + 2000);
    expect(svc.list()).toEqual([]);
    svc.dispose();
  });
});

describe('CronFireCoordinator', () => {
  it('steers the main agent on fire', async () => {
    const turn = new StubTurn();
    const handle: IScopeHandle = {
      id: 'main',
      kind: 2,
      accessor: { get: () => turn } as ServicesAccessor,
    };
    const agents: IAgentLifecycleService = {
      _serviceBrand: undefined,
      create: () => Promise.resolve(handle),
      createMain: () => Promise.resolve(handle),
      getHandle: (id) => (id === 'main' ? handle : undefined),
      list: () => [handle],
      remove: () => Promise.resolve(),
    };
    const cron = new CronService(
      undefined as never,
      activity(true),
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const coord = new CronFireCoordinator(cron, agents);
    await cron.create({ id: 'a', cron: '1000', prompt: 'steer-me', recurring: false });
    cron.tick(Date.now() + 2000);
    expect(turn.steered).toEqual(['steer-me']);
    coord.dispose();
    cron.dispose();
  });
});
