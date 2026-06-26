import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import type { ContextMessage } from '#/contextMemory';
import { ICronService } from '#/cron';
import { CronService } from '#/cron/cronService';
import type { ClockSources } from '#/cron/tools/clock';
import { IEventBus } from '#/eventBus';
import { IPromptService } from '#/prompt';
import { ITelemetryService } from '#/telemetry';
import { IToolRegistry } from '#/toolRegistry';
import { ITurnService, type Turn } from '#/turn';
import { IWireRecord } from '#/wireRecord';
import { stubWireRecord } from '../contextMemory/stubs';
import { stubTurn } from '../turn/stubs';

const FAR_FUTURE_MS = 10 * 366 * 24 * 60 * 60 * 1000;

function fakeTurn(): Turn {
  return {
    id: 1,
    abortController: new AbortController(),
    ready: Promise.resolve(),
    result: Promise.resolve({ reason: 'completed' }),
  };
}

function textOf(message: ContextMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
}

// NOTE: the legacy `CronFireCoordinator` (which steered the main agent on fire
// through `ITurnService.steer`) no longer exists in HEAD. Fire delivery now
// lives inside `CronService` itself: a due, idle task is delivered via
// `IPromptService.steer`. The cases below cover that path directly, so there is
// no separate coordinator suite to migrate.

describe('CronService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let now: number;
  let activeTurn: Turn | undefined;
  let steered: ContextMessage[];

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    now = 0;
    activeTurn = undefined;
    steered = [];

    const clocks: ClockSources = {
      wallNow: () => now,
      monoNowMs: () => now,
    };
    const turnService: ITurnService = {
      ...stubTurn(),
      getActiveTurn: () => activeTurn,
      cancel: () => {
        activeTurn = undefined;
      },
    };

    ix.stub(IPromptService, {
      prompt: () => undefined,
      steer: (message) => {
        steered.push(message);
        return fakeTurn();
      },
      retry: () => undefined,
      undo: () => 0,
      clear: () => {},
    });
    ix.stub(IEventBus, { emit: () => {}, on: () => ({ dispose: () => {} }) });
    ix.stub(IWireRecord, stubWireRecord());
    ix.stub(ITurnService, turnService);
    ix.stub(ITelemetryService, { track: () => {} });
    ix.stub(IToolRegistry, { register: () => ({ dispose: () => {} }) });
    ix.set(
      ICronService,
      new SyncDescriptor(CronService, [
        { autoStart: false, registerTools: false, clocks },
      ]),
    );
  });
  afterEach(() => disposables.dispose());

  it('addTask / list / removeTasks', () => {
    const svc = ix.get(ICronService);
    const task = svc.addTask({ cron: '* * * * *', prompt: 'hi', recurring: false });

    expect(svc.list()).toHaveLength(1);
    svc.removeTasks([task.id]);
    expect(svc.list()).toEqual([]);
  });

  it('does not fire while a turn is active', () => {
    const svc = ix.get(ICronService);
    svc.addTask({ cron: '* * * * *', prompt: 'fire-me', recurring: false });

    activeTurn = fakeTurn();
    now = FAR_FUTURE_MS;
    svc.tick();

    expect(steered).toEqual([]);
  });

  it('fires a due task when idle', () => {
    const svc = ix.get(ICronService);
    svc.addTask({ cron: '* * * * *', prompt: 'fire-me', recurring: false });

    now = FAR_FUTURE_MS;
    svc.tick();

    expect(steered).toHaveLength(1);
    expect(textOf(steered[0]!)).toContain('fire-me');
    expect(steered[0]!.origin).toMatchObject({ kind: 'cron_job' });
  });

  it('removes one-shot tasks after firing', () => {
    const svc = ix.get(ICronService);
    svc.addTask({ cron: '* * * * *', prompt: 'x', recurring: false });

    now = FAR_FUTURE_MS;
    svc.tick();

    expect(svc.list()).toEqual([]);
  });
});
