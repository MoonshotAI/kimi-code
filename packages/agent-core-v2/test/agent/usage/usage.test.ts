import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  IAgentUsageService,
  type UsageRecordedContext,
  type UsageStatus,
} from '#/agent/usage/usage';
import { AgentUsageService } from '#/agent/usage/usageService';
import { UsageModel } from '#/agent/usage/usageOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';

const SCOPE = 'wire';
const KEY = 'usage-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let svc: IAgentUsageService;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  ix.set(IAgentUsageService, new SyncDescriptor(AgentUsageService));
  log = ix.get(IAppendLogStore);
  svc = ix.get(IAgentUsageService);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, KEY)) {
    out.push(record);
  }
  return out;
}

function createFreshWire(logKey: string): { readonly fresh: IWireService; readonly freshLog: IAppendLogStore } {
  const freshIx = disposables.add(new TestInstantiationService());
  freshIx.stub(IFileSystemStorageService, new InMemoryStorageService());
  freshIx.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  freshIx.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey }]));
  return {
    fresh: freshIx.get(IAgentWireService),
    freshLog: freshIx.get(IAppendLogStore),
  };
}

const a1 = { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 };
const a2 = { inputOther: 10, output: 20, inputCacheRead: 30, inputCacheCreation: 40 };
const b1 = { inputOther: 100, output: 200, inputCacheRead: 300, inputCacheCreation: 400 };

describe('AgentUsageService (wire-backed)', () => {
  it('accumulates usage by model', () => {
    svc.record('model-a', a1);
    svc.record('model-a', a2);
    svc.record('model-b', b1);

    expect(svc.status()).toEqual({
      byModel: {
        'model-a': { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
        'model-b': b1,
      },
      total: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      currentTurn: undefined,
    });
  });

  it('tracks current turn usage by turn id', () => {
    svc.record('model-a', a1);
    svc.record('model-a', a2, { type: 'turn', turnId: 1 });
    svc.record('model-b', b1, { type: 'turn', turnId: 1 });

    expect(svc.status()).toMatchObject({
      total: { inputOther: 111, output: 222, inputCacheRead: 333, inputCacheCreation: 444 },
      currentTurn: { inputOther: 110, output: 220, inputCacheRead: 330, inputCacheCreation: 440 },
    });

    svc.record('model-a', { inputOther: 5, output: 6, inputCacheRead: 7, inputCacheCreation: 8 }, {
      type: 'turn',
      turnId: 2,
    });

    expect(svc.status().currentTurn).toEqual({
      inputOther: 5,
      output: 6,
      inputCacheRead: 7,
      inputCacheCreation: 8,
    });
  });

  it('returns immutable status snapshots', () => {
    svc.record('model-a', a1);
    const snapshot = svc.status();

    svc.record('model-a', a2);

    expect(snapshot).toEqual({
      byModel: { 'model-a': a1 },
      total: a1,
      currentTurn: undefined,
    });
  });

  it('emits agent.status.updated with the usage snapshot after each live record', () => {
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    svc.record('model-a', a1);

    expect(events).toEqual([
      {
        type: 'agent.status.updated',
        usage: {
          byModel: { 'model-a': a1 },
          total: a1,
          currentTurn: undefined,
        } satisfies UsageStatus,
      },
    ]);
  });

  it('fires onDidRecord with the live usage context', () => {
    const contexts: UsageRecordedContext[] = [];
    disposables.add(
      svc.onDidRecord((ctx) => {
        contexts.push(ctx);
      }),
    );

    svc.record('model-a', a1, { type: 'turn', turnId: 7, step: 2 });

    expect(contexts).toEqual([
      {
        model: 'model-a',
        usage: a1,
        source: { type: 'turn', turnId: 7, step: 2 },
      },
    ]);
  });

  it('dispatch persists flat { type, model, usage, usageScope } records (no payload key)', async () => {
    svc.record('model-a', a1);

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'usage.record',
        model: 'model-a',
        usage: a1,
        usageScope: 'session',
        time: expect.any(Number),
      },
    ]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('marks turn-scoped sources with usageScope only (no turnId or context persisted)', async () => {
    svc.record('model-a', a1, { type: 'turn', turnId: 7, step: 2 });

    const records = await readRecords();
    expect(records).toEqual([
      {
        type: 'usage.record',
        model: 'model-a',
        usage: a1,
        usageScope: 'turn',
        time: expect.any(Number),
      },
    ]);
  });

  it('replay rebuilds usage from persisted records on a fresh WireService (silent)', async () => {
    svc.record('model-a', a1);
    svc.record('model-a', a2, { type: 'turn', turnId: 1 });
    const records = await readRecords();

    const { fresh, freshLog } = createFreshWire('usage-replay');

    await fresh.replay(...records);

    expect(fresh.getModel(UsageModel).byModel).toEqual({
      'model-a': { inputOther: 11, output: 22, inputCacheRead: 33, inputCacheCreation: 44 },
    });

    const written: PersistedRecord[] = [];
    for await (const record of freshLog.read<PersistedRecord>(SCOPE, 'usage-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });

  it('replays legacy turn context records into byModel totals only (currentTurn is not rebuilt)', async () => {
    const { fresh } = createFreshWire('usage-legacy-context-replay');

    await fresh.replay({
      type: 'usage.record',
      model: 'model-a',
      usage: a1,
      usageScope: 'turn',
      turnId: 1,
      context: { type: 'turn', turnId: 9, step: 3 },
    });

    expect(fresh.getModel(UsageModel)).toEqual({
      byModel: { 'model-a': a1 },
    });
  });
});
