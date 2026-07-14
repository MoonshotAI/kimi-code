import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import {
  CompactionModel,
  fullCompactionBegin,
  fullCompactionCancel,
  fullCompactionComplete,
} from '#/agent/fullCompaction/compactionOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService, PersistedRecord } from '#/wire/wireService';
import { WireService } from '#/wire/wireServiceImpl';

const SCOPE = 'wire';
const KEY = 'full-compaction-test';

let disposables: DisposableStore;
let wire: IWireService;
let log: IAppendLogStore;

function buildHost(key: string): { wire: IWireService; log: IAppendLogStore; eventBus: IEventBus } {
  const ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: key }]));
  ix.set(IEventBus, new SyncDescriptor(EventBusService));
  return { wire: ix.get(IAgentWireService), log: ix.get(IAppendLogStore), eventBus: ix.get(IEventBus) };
}

beforeEach(() => {
  disposables = new DisposableStore();
  const host = buildHost(KEY);
  wire = host.wire;
  log = host.log;
});

afterEach(() => disposables.dispose());

async function readRecords(key = KEY): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, key)) {
    out.push(record);
  }
  return out;
}

describe('fullCompaction ops (wire-backed)', () => {
  it('begin/complete/cancel drive the phase and persist flat records', async () => {
    expect(wire.getModel(CompactionModel).phase).toBe('idle');

    wire.dispatch(fullCompactionBegin({ source: 'manual', instruction: 'keep facts' }));
    expect(wire.getModel(CompactionModel).phase).toBe('running');

    wire.dispatch(fullCompactionComplete({}));
    expect(wire.getModel(CompactionModel).phase).toBe('idle');

    wire.dispatch(fullCompactionBegin({ source: 'auto' }));
    expect(wire.getModel(CompactionModel).phase).toBe('running');
    wire.dispatch(fullCompactionCancel({}));
    expect(wire.getModel(CompactionModel).phase).toBe('idle');

    const records = await readRecords();
    expect(records.map((record) => record.type)).toEqual([
      'full_compaction.begin',
      'full_compaction.complete',
      'full_compaction.begin',
      'full_compaction.cancel',
    ]);
    expect(records.every((record) => 'payload' in record === false)).toBe(true);
    expect(records[0]).toEqual(
      expect.objectContaining({
        type: 'full_compaction.begin',
        source: 'manual',
        instruction: 'keep facts',
      }),
    );
    expect(records[1]).toEqual({ type: 'full_compaction.complete', time: expect.any(Number) });
  });

  it('apply returns the same reference on a no-op (gate stays quiet)', () => {
    wire.dispatch(fullCompactionCancel({}));
    const idle = wire.getModel(CompactionModel);
    wire.dispatch(fullCompactionCancel({}));
    expect(wire.getModel(CompactionModel)).toBe(idle);

    wire.dispatch(fullCompactionBegin({ source: 'manual' }));
    const running = wire.getModel(CompactionModel);
    wire.dispatch(fullCompactionBegin({ source: 'auto' }));
    expect(wire.getModel(CompactionModel)).toBe(running);
  });

  it('replay rebuilds the phase silently (no emissions, no subscriber notifications)', async () => {
    wire.dispatch(fullCompactionBegin({ source: 'manual' }));
    wire.dispatch(fullCompactionComplete({}));
    const records = await readRecords();

    const host = buildHost('full-compaction-replay');
    const emissions: string[] = [];
    host.eventBus.subscribe((e) => {
      emissions.push(e.type);
    });
    let modelChanges = 0;
    host.wire.subscribe(CompactionModel, () => {
      modelChanges += 1;
    });

    await host.wire.replay(...records);
    expect(host.wire.getModel(CompactionModel).phase).toBe('idle');
    expect(emissions).toEqual([]);
    expect(modelChanges).toBe(0);

    const stranded = buildHost('full-compaction-stranded');
    await stranded.wire.replay({ type: 'full_compaction.begin', source: 'auto' });
    expect(stranded.wire.getModel(CompactionModel).phase).toBe('running');
  });

  it('replays legacy complete payloads that carried accounting numbers', async () => {
    const host = buildHost('full-compaction-legacy-complete-replay');

    await host.wire.replay(
      { type: 'full_compaction.begin', source: 'manual' },
      { type: 'full_compaction.complete', compactedCount: 1, tokensBefore: 50, tokensAfter: 10 },
    );

    expect(host.wire.getModel(CompactionModel).phase).toBe('idle');
  });
});
