import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { ClusterDb } from '@moonshot-ai/minidb/cluster';
import { drainQueryStoreDisposals, MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { IQueryStore, QueryStoreRebuiltError } from '#/persistence/interface/queryStore';
import { stubBootstrap } from '../../../app/bootstrap/stubs';
import { stubLog } from '../../../_base/log/stubs';

const COLLECTION = 'session';
const SEP = String.fromCodePoint(0);

describe('MiniDbQueryStore', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'minidb-qs-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await drainQueryStoreDisposals();
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): IQueryStore {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
    ]);
    disposeHost = () => { host.dispose(); };
    return host.app.accessor.get(IQueryStore);
  }

  it('put/get/delete round-trip', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', v: 1 });
    expect(await store.get(COLLECTION, 'a')).toEqual({ id: 'a', v: 1 });
    expect(await store.get(COLLECTION, 'missing')).toBeUndefined();
    await store.delete(COLLECTION, 'a');
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
  });

  it('batch applies put and delete atomically', async () => {
    const store = build();
    await store.batch([
      { kind: 'put', collection: COLLECTION, key: 'a', value: { v: 1 } },
      { kind: 'put', collection: COLLECTION, key: 'b', value: { v: 2 } },
    ]);
    expect(await store.get(COLLECTION, 'a')).toEqual({ v: 1 });
    await store.batch([{ kind: 'delete', collection: COLLECTION, key: 'a' }]);
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    expect(await store.get(COLLECTION, 'b')).toEqual({ v: 2 });
  });

  it('isolates collections by prefix', async () => {
    const store = build();
    await store.batch([
      { kind: 'put', collection: 'c1', key: 'k', value: { v: 1 } },
      { kind: 'put', collection: 'c2', key: 'k', value: { v: 2 } },
    ]);
    expect(await store.get('c1', 'k')).toEqual({ v: 1 });
    expect(await store.get('c2', 'k')).toEqual({ v: 2 });
  });

  it('query filters, orders, limits and paginates with cursor', async () => {
    const store = build();
    await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byWs', field: 'ws' });
    await store.batch(
      (
      [
        ['a', 'x', 1],
        ['b', 'x', 3],
        ['c', 'y', 5],
        ['d', 'x', 2],
      ] as const
      ).map(([id, ws, n]) => ({ kind: 'put' as const, collection: COLLECTION, key: id, value: { id, ws, n } })),
    );

    const page1 = await store
      .query<{ id: string; ws: string; n: number }>(COLLECTION)
      .where({ ws: 'x' })
      .orderBy('n', 'desc')
      .limit(2)
      .execute();
    expect(page1.items.map((i) => i.id)).toEqual(['b', 'd']);
    expect(page1.nextCursor).toBe('2');

    const page2 = await store
      .query<{ id: string; ws: string; n: number }>(COLLECTION)
      .where({ ws: 'x' })
      .orderBy('n', 'desc')
      .limit(2)
      .cursor(page1.nextCursor)
      .execute();
    expect(page2.items.map((i) => i.id)).toEqual(['a']);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('ensureIndex is idempotent across value and compound kinds', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', ws: 'x', n: 1, body: 'hello world' });
    await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byWs', field: 'ws' });
    await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byWs', field: 'ws' });
    await store.ensureIndex(COLLECTION, { kind: 'compound', name: 'byWsN', groupBy: 'ws', orderBy: 'n' });
    await store.ensureIndex(COLLECTION, { kind: 'compound', name: 'byWsN', groupBy: 'ws', orderBy: 'n' });
    const page = await store.query(COLLECTION).where({ ws: 'x' }).execute();
    expect(page.items).toHaveLength(1);
  });

  it('rejects text indexes: the query-store is a structural read model', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', body: 'hello world' });
    await expect(
      store.ensureIndex(COLLECTION, { kind: 'text', name: 'body', fields: ['body'] }),
    ).rejects.toThrow(/structural read model/);
    await expect(
      store.ensureIndex(COLLECTION, { kind: 'text', name: 'body', fields: ['body'] }),
    ).rejects.toThrow(/structural read model/);
    const storeDir = join(homeDir, 'cache', 'query-store');
    const shardEntries = await fsp.readdir(join(storeDir, 'shard-00'));
    expect(shardEntries.filter((name) => name.includes('text'))).toEqual([]);
  });

  it('shares the store with a second cluster instance instead of locking it out', async () => {
    const storeDir = join(homeDir, 'cache', 'query-store');
    const peer = await ClusterDb.open({ dir: storeDir, shardCount: 16, valueCodec: 'json' });
    try {
      const store = build();
      await peer.set(`${COLLECTION}${SEP}peer`, { id: 'peer', v: 1 });
      expect(await store.get(COLLECTION, 'peer')).toEqual({ id: 'peer', v: 1 });
      await store.put(COLLECTION, 'mine', { id: 'mine', v: 2 });
      expect(await peer.get(`${COLLECTION}${SEP}mine`)).toEqual({ id: 'mine', v: 2 });
      await store.close();
    } finally {
      await peer.close();
    }
  });

  it('wipes and rebuilds the store after the cluster registry is corrupted', async () => {
    const first = build();
    await first.put(COLLECTION, 'a', { id: 'a', v: 1 });
    await first.ensureIndex(COLLECTION, { kind: 'value', name: 'byV', field: 'v' });
    await first.close();
    disposeHost?.();
    disposeHost = undefined;

    const registryFile = join(homeDir, 'cache', 'query-store', 'cluster.indexes.json');
    await fsp.writeFile(registryFile, '{ definitely not valid json');

    const second = build();
    await expect(
      second.ensureIndex(COLLECTION, { kind: 'value', name: 'byV', field: 'v' }),
    ).rejects.toThrow(SyntaxError);
    expect(await second.get(COLLECTION, 'a')).toBeUndefined();
    await second.ensureIndex(COLLECTION, { kind: 'value', name: 'byV', field: 'v' });
    await second.put(COLLECTION, 'b', { id: 'b', v: 2 });
    const page = await second.query<{ id: string; v: number }>(COLLECTION).where({ v: 2 }).execute();
    expect(page.items).toEqual([{ id: 'b', v: 2 }]);
  });

  it('wipes and rebuilds the store after poison-class or persistent transient failures', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', v: 1 });
    const internal = store as unknown as { dbPromise: Promise<ClusterDb> };
    const db = await internal.dbPromise;
    const poisoned = Object.assign(new Error('poisoned'), { code: 'WAL_POISONED' });
    (db as unknown as { set: unknown }).set = () => Promise.reject(poisoned);
    await expect(store.put(COLLECTION, 'b', { id: 'b', v: 2 })).rejects.toThrow('poisoned');
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    await store.put(COLLECTION, 'b', { id: 'b', v: 2 });
    expect(await store.get(COLLECTION, 'b')).toEqual({ id: 'b', v: 2 });

    const db2 = await internal.dbPromise;
    const locked = Object.assign(new Error('locked'), { code: 'ELOCKED' });
    (db2 as unknown as { set: unknown }).set = () => Promise.reject(locked);
    for (let i = 0; i < 4; i++) {
      await expect(store.put(COLLECTION, `t${i}`, { v: i })).rejects.toThrow('locked');
      expect(await store.get(COLLECTION, 'b')).toEqual({ id: 'b', v: 2 });
    }
    await expect(store.put(COLLECTION, 'c', { id: 'c', v: 3 })).rejects.toThrow('locked');
    expect(await store.get(COLLECTION, 'b')).toBeUndefined();
    await store.put(COLLECTION, 'c', { id: 'c', v: 3 });
    expect(await store.get(COLLECTION, 'c')).toEqual({ id: 'c', v: 3 });

    const storeDir = join(homeDir, 'cache', 'query-store');
    const peer = await ClusterDb.open({ dir: storeDir, shardCount: 16, valueCodec: 'json', lockHoldMs: 0 });
    await peer.set(`${COLLECTION}${SEP}peer`, { id: 'peer', v: 9 });
    const db3 = await internal.dbPromise;
    (db3 as unknown as { set: unknown }).set = () => Promise.reject(poisoned);
    await expect(store.put(COLLECTION, 'd', { v: 4 })).rejects.toThrow('poisoned');
    expect(await peer.get(`${COLLECTION}${SEP}peer`)).toEqual({ id: 'peer', v: 9 });
    expect(await store.get(COLLECTION, 'c')).toEqual({ id: 'c', v: 3 });

    const db4 = await internal.dbPromise;
    (db4 as unknown as { set: unknown }).set = () => Promise.reject(poisoned);
    await peer.close();
    await expect(store.put(COLLECTION, 'd', { v: 4 })).rejects.toThrow('poisoned');
    expect(await store.get(COLLECTION, 'c')).toBeUndefined();
    await store.put(COLLECTION, 'd', { v: 4 });
    expect(await store.get(COLLECTION, 'd')).toEqual({ v: 4 });

    const epoch = store.storeEpoch();
    const db5 = await internal.dbPromise;
    (db5 as unknown as { set: unknown }).set = () => Promise.reject(poisoned);
    await expect(store.put(COLLECTION, 'e', { v: 5 })).rejects.toThrow('poisoned');
    expect(store.storeEpoch()).toBe(epoch + 1);
    await expect(store.setCheckpoint('projection', { seq: 7 }, epoch)).rejects.toThrow(
      QueryStoreRebuiltError,
    );
    expect(await store.getCheckpoint('projection')).toBeUndefined();
    await store.setCheckpoint('projection', { seq: 7 }, store.storeEpoch());
    expect(await store.getCheckpoint('projection')).toEqual({ seq: 7 });
  });

  it('getMany returns present values and skips missing keys', async () => {
    const store = build();
    await store.batch([
      { kind: 'put', collection: COLLECTION, key: 'a', value: { v: 1 } },
      { kind: 'put', collection: COLLECTION, key: 'b', value: { v: 2 } },
    ]);
    const found = await store.getMany<{ v: number }>(COLLECTION, ['a', 'missing', 'b']);
    expect([...found.keys()].sort()).toEqual(['a', 'b']);
    expect(found.get('a')).toEqual({ v: 1 });
    expect(found.get('b')).toEqual({ v: 2 });
    expect(await store.getMany(COLLECTION, [])).toEqual(new Map());
  });

  it('pageByColumn walks the ordered column with bounds, filter and limit', async () => {
    const store = build();
    const seed = [];
    for (let i = 0; i < 50; i++) {
      seed.push({
        kind: 'put' as const,
        collection: COLLECTION,
        key: `s${i}`,
        value: { id: `s${i}`, ws: i % 2 === 0 ? 'x' : 'y', updatedAt: i },
        columns: { updatedAt: i },
      });
    }
    await store.batch(seed);

    const first = await store.pageByColumn<{ id: string; updatedAt: number }>(COLLECTION, {
      column: 'updatedAt',
      dir: 'desc',
      limit: 20,
    });
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.updatedAt).toBe(49);
    expect(first.items[19]?.updatedAt).toBe(30);

    const bounded = await store.pageByColumn<{ id: string; updatedAt: number }>(COLLECTION, {
      column: 'updatedAt',
      dir: 'desc',
      bounds: { lt: 30 },
      filter: { ws: 'x' },
      limit: 3,
    });
    expect(bounded.items.map((i) => i.updatedAt)).toEqual([28, 26, 24]);

    const asc = await store.pageByColumn<{ id: string; updatedAt: number }>(COLLECTION, {
      column: 'updatedAt',
      bounds: { gte: 45 },
      limit: 10,
    });
    expect(asc.items.map((i) => i.updatedAt)).toEqual([45, 46, 47, 48, 49]);
  });

  it('pageByColumn stays cheap as the collection grows', async () => {
    const store = build();
    const seed = async (from: number, to: number): Promise<void> => {
      for (let start = from; start < to; start += 500) {
        const ops = [];
        for (let i = start; i < Math.min(start + 500, to); i++) {
          ops.push({
            kind: 'put' as const,
            collection: COLLECTION,
            key: `s${i}`,
            value: { id: `s${i}`, updatedAt: i },
            columns: { updatedAt: i },
          });
        }
        await store.batch(ops);
      }
    };
    const medianPageMs = async (): Promise<number> => {
      const runs: number[] = [];
      for (let r = 0; r < 5; r++) {
        const t0 = performance.now();
        const page = await store.pageByColumn(COLLECTION, {
          column: 'updatedAt',
          dir: 'desc',
          limit: 20,
        });
        expect(page.items).toHaveLength(20);
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      return runs[(runs.length / 2) | 0]!;
    };

    await seed(0, 1_000);
    const small = await medianPageMs();
    await seed(1_000, 10_000);
    const large = await medianPageMs();
    console.log(
      `[baseline] queryStore pageByColumn ${JSON.stringify({ rows: [1000, 10000], medianMs: [small, large] })}`,
    );
    expect(large).toBeLessThan(small * 10 + 100);
  }, 60_000);

  it('listKeys and dropCollection operate on the whole collection', async () => {
    const store = build();
    await store.batch([
      { kind: 'put', collection: COLLECTION, key: 'a', value: { v: 1 } },
      { kind: 'put', collection: COLLECTION, key: 'b', value: { v: 2 } },
      { kind: 'put', collection: 'other', key: 'c', value: { v: 3 } },
    ]);
    expect((await store.listKeys(COLLECTION)).toSorted()).toEqual(['a', 'b']);

    await store.dropCollection(COLLECTION);
    expect(await store.listKeys(COLLECTION)).toEqual([]);
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    expect(await store.get('other', 'c')).toEqual({ v: 3 });
    await store.dropCollection(COLLECTION);
  });

  it('whereColumn bounds the query range alongside equality filters', async () => {
    const store = build();
    await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byParent', field: 'parent' });
    await store.batch(
      (
        [
          ['a', 'p', 1],
          ['b', 'p', 5],
          ['c', 'p', 9],
          ['d', 'q', 7],
        ] as const
      ).map(([id, parent, n]) => ({
        kind: 'put' as const,
        collection: COLLECTION,
        key: id,
        value: { id, parent, updatedAt: n },
        columns: { updatedAt: n },
      })),
    );

    const page = await store
      .query<{ id: string; parent: string; updatedAt: number }>(COLLECTION)
      .where({ parent: 'p' })
      .whereColumn('updatedAt', { lt: 6 })
      .orderBy('updatedAt', 'desc')
      .limit(10)
      .execute();
    expect(page.items.map((i) => i.id)).toEqual(['b', 'a']);
  });
});
