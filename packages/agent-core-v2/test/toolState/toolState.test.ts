import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentToolState } from '#/agent/toolState';
import { AgentToolStateService } from '#/agent/toolState/toolStateService';
import { ToolStoreModel } from '#/agent/toolState/toolStateOps';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAgentWireService, WireService, type PersistedRecord } from '#/wire';

const SCOPE = 'wire';
const KEY = 'tool-state-test';

let disposables: DisposableStore;
let ix: TestInstantiationService;
let log: IAppendLogStore;
let svc: IAgentToolState;

beforeEach(() => {
  disposables = new DisposableStore();
  ix = disposables.add(new TestInstantiationService());
  ix.stub(IFileSystemStorageService, new InMemoryStorageService());
  ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
  ix.set(IAgentWireService, new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: KEY }]));
  ix.set(IAgentToolState, new SyncDescriptor(AgentToolStateService));
  log = ix.get(IAppendLogStore);
  svc = ix.get(IAgentToolState);
});

afterEach(() => disposables.dispose());

async function readRecords(): Promise<PersistedRecord[]> {
  const out: PersistedRecord[] = [];
  for await (const record of log.read<PersistedRecord>(SCOPE, KEY)) {
    out.push(record);
  }
  return out;
}

describe('AgentToolStateService (wire-backed)', () => {
  it('set/get round-trips and fires onUpdated with key/value', () => {
    const updates: { key: string; value: unknown }[] = [];
    svc.hooks.onUpdated.register('test', (ctx, next) => {
      updates.push({ key: ctx.key, value: ctx.value });
      return next();
    });

    expect(svc.get('answer' as never)).toBeUndefined();
    svc.set('answer' as never, 42 as never);

    expect(svc.get('answer' as never)).toBe(42);
    expect(updates).toEqual([{ key: 'answer', value: 42 }]);
  });

  it('data() returns a snapshot of the store', () => {
    svc.set('a' as never, 1 as never);
    svc.set('b' as never, 'two' as never);
    expect(svc.data()).toEqual({ a: 1, b: 'two' });
  });

  it('dispatch persists a flat { type, key, value } record (no payload key)', async () => {
    svc.set('answer' as never, 42 as never);

    const records = await readRecords();
    expect(records).toEqual([
      { type: 'tools.update_store', key: 'answer', value: 42, time: expect.any(Number) },
    ]);
    expect('payload' in records[0]!).toBe(false);
  });

  it('replay rebuilds the store from persisted records (silent, no onUpdated)', async () => {
    svc.set('a' as never, 1 as never);
    const records = await readRecords();

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix2.set(
      IAgentWireService,
      new SyncDescriptor(WireService, [{ logScope: SCOPE, logKey: 'tool-state-replay' }]),
    );
    const log2 = ix2.get(IAppendLogStore);
    const fresh = ix2.get(IAgentWireService);

    const freshSvc = new AgentToolStateService(fresh);
    disposables.add(freshSvc);
    let fired = 0;
    freshSvc.hooks.onUpdated.register('test', (_ctx, next) => {
      fired += 1;
      return next();
    });

    fresh.replay(...records);

    expect(fresh.getModel(ToolStoreModel)).toEqual({ a: 1 });
    expect(fired).toBe(0);

    const written: PersistedRecord[] = [];
    for await (const record of log2.read<PersistedRecord>(SCOPE, 'tool-state-replay')) {
      written.push(record);
    }
    expect(written).toEqual([]);
  });
});
