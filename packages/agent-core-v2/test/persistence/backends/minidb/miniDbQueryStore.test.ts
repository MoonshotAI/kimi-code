import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { MiniDb } from '@moonshot-ai/minidb';
import { MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { stubBootstrap } from '../../../app/bootstrap/stubs';
import { stubLog } from '../../../_base/log/stubs';

const COLLECTION = 'session';

describe('MiniDbQueryStore', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      InstantiationType.Delayed,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'minidb-qs-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
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

  it('ensureIndex is idempotent across value, compound and text kinds', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', ws: 'x', n: 1, body: 'hello world' });
    await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byWs', field: 'ws' });
    await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byWs', field: 'ws' });
    await store.ensureIndex(COLLECTION, { kind: 'compound', name: 'byWsN', groupBy: 'ws', orderBy: 'n' });
    await store.ensureIndex(COLLECTION, { kind: 'text', name: 'body', fields: ['body'] });
    await store.ensureIndex(COLLECTION, { kind: 'text', name: 'body', fields: ['body'] });
    const page = await store.query(COLLECTION).where({ ws: 'x' }).execute();
    expect(page.items).toHaveLength(1);
  });

  it('stores checkpoints', async () => {
    const store = build();
    expect(await store.getCheckpoint('wire:abc')).toBeUndefined();
    await store.setCheckpoint('wire:abc', { seq: 42 });
    expect(await store.getCheckpoint('wire:abc')).toEqual({ seq: 42 });
  });

  it('throws storage.locked when the database lock is held by another process', async () => {
    const storeDir = join(homeDir, 'cache', 'query-store');
    const lockHolder = await MiniDb.open({ dir: storeDir, valueCodec: 'json' });
    try {
      const store = build();
      await expect(store.put(COLLECTION, 'a', { id: 'a' })).rejects.toMatchObject({
        code: 'storage.locked',
      });
      await expect(
        store.batch([{ kind: 'put', collection: COLLECTION, key: 'b', value: { id: 'b' } }]),
      ).rejects.toMatchObject({ code: 'storage.locked' });
      await expect(
        store.ensureIndex(COLLECTION, { kind: 'value', name: 'byId', field: 'id' }),
      ).rejects.toMatchObject({ code: 'storage.locked' });
      await expect(store.get(COLLECTION, 'a')).rejects.toMatchObject({
        code: 'storage.locked',
      });
      await expect(store.getCheckpoint('wire:abc')).rejects.toMatchObject({
        code: 'storage.locked',
      });
      await expect(store.query(COLLECTION).execute()).rejects.toMatchObject({
        code: 'storage.locked',
      });
      await expect(store.close()).resolves.toBeUndefined();
    } finally {
      await lockHolder.close();
    }
  });

  it('rebuilds a clean store after on-disk corruption', async () => {
    const first = build();
    await first.put(COLLECTION, 'a', { v: 1 });
    await first.ensureIndex(COLLECTION, { kind: 'value', name: 'byV', field: 'v' });
    await first.close();
    disposeHost?.();
    disposeHost = undefined;

    const indexFile = join(homeDir, 'cache', 'query-store', 'db.indexes.json');
    await fsp.writeFile(indexFile, '{ definitely not valid json');

    const second = build();
    expect(await second.get(COLLECTION, 'a')).toBeUndefined();
  });
});
