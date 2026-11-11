import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fsp } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { drainQueryStoreDisposals, DualWriteQueryStore } from '#/persistence/backends/dualWriteQueryStore';
import { MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { sqliteNativeBinding } from '#/persistence/backends/sqlite/sqliteQueryStore';
import { IQueryStore, QueryStoreRebuiltError } from '#/persistence/interface/queryStore';
import { stubBootstrap } from '../../app/bootstrap/stubs';
import { stubLog } from '../../_base/log/stubs';

const COLLECTION = 'session';
const STORE_FILE = 'query-store.sqlite';

function backup(store: IQueryStore): MiniDbQueryStore {
  return (store as unknown as { minidb: MiniDbQueryStore }).minidb;
}

describe('DualWriteQueryStore', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      DualWriteQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'sqlite-qs-'));
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

  it('put/get/delete round-trip and resets after a backup delete failure', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', v: 1 });
    expect(await store.get(COLLECTION, 'a')).toEqual({ id: 'a', v: 1 });
    expect(await backup(store).get(COLLECTION, 'a')).toEqual({ id: 'a', v: 1 });
    expect(await store.get(COLLECTION, 'missing')).toBeUndefined();
    await store.delete(COLLECTION, 'a');
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    expect(await backup(store).get(COLLECTION, 'a')).toBeUndefined();

    await store.put(COLLECTION, 'a', { id: 'a', v: 2 });
    await store.setCheckpoint('projection', { seq: 1 });
    backup(store).delete = async () => {
      throw new Error('minidb delete failed');
    };
    await expect(store.delete(COLLECTION, 'a')).rejects.toThrow('minidb delete failed');
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    expect(await store.getCheckpoint('projection')).toBeUndefined();
    expect(await backup(store).get(COLLECTION, 'a')).toEqual({ id: 'a', v: 2 });
  });

  it('batch keeps SQLite atomic and resets after non-atomic minidb failures', async () => {
    const store = build();
    await store.batch([
      { kind: 'put', collection: COLLECTION, key: 'a', value: { v: 1 } },
      { kind: 'put', collection: COLLECTION, key: 'b', value: { v: 2 } },
    ]);
    expect(await store.get(COLLECTION, 'a')).toEqual({ v: 1 });
    expect(await backup(store).get(COLLECTION, 'a')).toEqual({ v: 1 });
    await expect(
      store.batch([
        { kind: 'put', collection: COLLECTION, key: 'c', value: { v: 3 } },
        { kind: 'put', collection: COLLECTION, key: 'invalid', value: undefined },
      ]),
    ).rejects.toThrow(TypeError);
    expect(await store.get(COLLECTION, 'c')).toBeUndefined();
    expect(await store.get(COLLECTION, 'invalid')).toBeUndefined();
    expect(await backup(store).get(COLLECTION, 'c')).toBeUndefined();

    const minidb = backup(store);
    const originalBatch = minidb.batch.bind(minidb);
    let failNextBatch = true;
    minidb.batch = async (ops) => {
      if (failNextBatch) {
        failNextBatch = false;
        throw new Error('minidb batch failed');
      }
      await originalBatch(ops);
    };
    const retry = [{ kind: 'put' as const, collection: COLLECTION, key: 'c', value: { v: 3 } }];
    await expect(store.batch(retry)).rejects.toThrow('minidb batch failed');
    expect(await store.get(COLLECTION, 'c')).toBeUndefined();
    expect(await minidb.get(COLLECTION, 'c')).toBeUndefined();
    await store.batch(retry);
    expect(await minidb.get(COLLECTION, 'c')).toEqual({ v: 3 });

    await store.batch([{ kind: 'delete', collection: COLLECTION, key: 'a' }]);
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    expect(await minidb.get(COLLECTION, 'a')).toBeUndefined();
    expect(await store.get(COLLECTION, 'b')).toBeUndefined();

    class DelayedResetStore extends DualWriteQueryStore {
      override async resetAfterPeerRebuild(): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return super.resetAfterPeerRebuild();
      }
    }
    const concurrent = new DelayedResetStore(stubBootstrap(homeDir), stubLog());
    const concurrentBackup = backup(concurrent);
    const originalPut = concurrentBackup.put.bind(concurrentBackup);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    concurrentBackup.put = async (collection, key, value, options) => {
      if (key === 'first') {
        markStarted();
        (concurrentBackup as unknown as { storeEpochCounter: number }).storeEpochCounter += 1;
        await firstGate;
        throw new Error('minidb put rebuilt');
      }
      return originalPut(collection, key, value, options);
    };
    const first = concurrent.put(COLLECTION, 'first', { value: 1 });
    await started;
    const second = concurrent.put(COLLECTION, 'second', { value: 2 });
    releaseFirst();
    await expect(first).rejects.toThrow('minidb put rebuilt');
    await second;
    expect(await concurrent.get(COLLECTION, 'second')).toEqual({ value: 2 });
    expect(await concurrentBackup.get(COLLECTION, 'second')).toEqual({ value: 2 });
    expect(await concurrent.get(COLLECTION, 'first')).toBeUndefined();
    expect(await concurrentBackup.get(COLLECTION, 'first')).toBeUndefined();
    await concurrent.close();
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
      ).map(([id, ws, n]) => ({
        kind: 'put' as const,
        collection: COLLECTION,
        key: id,
        value: { id, ws, n },
      })),
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

    const filterDocs = [
      {
        id: 'a',
        nested: { items: [{ name: 'Alpha' }] },
        nullable: null,
        tags: ['red', 'blue'],
        count: 4,
        text: 'Alpha-123',
        kind: 'x',
      },
      {
        id: 'b',
        nested: { items: [{ name: 'Beta' }] },
        tags: ['green'],
        count: 7,
        text: 'beta-456',
        kind: 'y',
        optional: 0,
      },
      {
        id: 'c',
        nested: { items: [{ name: 'Gamma' }] },
        nullable: 'value',
        tags: ['red'],
        count: 12,
        text: 'gamma-789',
        kind: 'y',
      },
    ];
    await store.batch(
      filterDocs.map((value) => ({
        kind: 'put' as const,
        collection: 'filters',
        key: value.id,
        value,
      })),
    );
    const filteredIds = async (filter: Record<string, unknown>): Promise<string[]> =>
      (await store.query<{ id: string }>('filters').where(filter).execute()).items.map(
        (item) => item.id,
      );
    expect(
      await filteredIds({
        $and: [
          { 'nested.items[0].name': { $regex: ['^alpha$', 'i'] } },
          { tags: { $contains: 'red' } },
          { count: { $gte: 4, $lt: 10, $type: 'number' } },
        ],
      }),
    ).toEqual(['a']);
    expect(await filteredIds({ $or: [{ count: { $in: [7, 99] } }, { id: { $eq: 'c' } }] })).toEqual([
      'b',
      'c',
    ]);
    expect(await filteredIds({ $nor: [{ kind: 'y' }] })).toEqual(['a']);
    expect(await filteredIds({ $not: { tags: { $contains: 'red' } } })).toEqual(['b']);
    expect(await filteredIds({ count: { $nin: [4, 12] } })).toEqual(['b']);
    expect(await filteredIds({ optional: { $exists: false } })).toEqual(['a', 'c']);
    expect(await filteredIds({ nullable: { $ne: null } })).toEqual(['b', 'c']);
    expect(await filteredIds({ count: { $gt: 4, $lte: 12 } })).toEqual(['b', 'c']);
    const stateful = /a/g;
    expect(await filteredIds({ text: stateful })).toEqual(['a', 'b', 'c']);
    expect(await filteredIds({ text: stateful })).toEqual(['a', 'b', 'c']);

    const sortDocs = [
      { id: 'a' },
      { id: 'b', sort: null },
      { id: 'c', sort: 2 },
      { id: 'd', sort: 1 },
      { id: 'e' },
    ];
    await store.batch(
      sortDocs.map((value) => ({
        kind: 'put' as const,
        collection: 'sort',
        key: value.id,
        value,
      })),
    );
    const expected = [...sortDocs].sort((a, b) => {
      const av = (a as { sort?: unknown }).sort as number | string;
      const bv = (b as { sort?: unknown }).sort as number | string;
      return av < bv ? -1 : av > bv ? 1 : 0;
    });
    const sorted = await store.query('sort').orderBy('sort').execute();
    expect(sorted.items).toEqual(expected);
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

    await store.ensureIndex('unique', { kind: 'value', name: 'byValue', field: 'value', unique: true });
    await store.put('unique', 'false', { value: false });
    await store.put('unique', 'zero', { value: 0 });
    await store.put('unique', 'object-a', { value: { a: 1, b: 2 } });
    await expect(
      store.put('unique', 'object-b', { value: { b: 2, a: 1 } }),
    ).rejects.toThrow(/UniqueViolationError|unique index/);
    expect(await store.get('unique', 'object-b')).toBeUndefined();

    const peer = new Database(join(homeDir, 'cache', STORE_FILE), { readonly: true });
    try {
      const indexes = peer
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'qs_%'")
        .all() as { name: string }[];
      expect(indexes.some((index) => index.name.startsWith('qs_value_'))).toBe(true);
      expect(indexes.some((index) => index.name.startsWith('qs_compound_'))).toBe(true);
    } finally {
      peer.close();
    }
  });

  it('rejects text indexes, dual-writes checkpoints and preserves legacy derived caches', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', body: 'hello world' });
    await expect(
      store.ensureIndex(COLLECTION, { kind: 'text', name: 'body', fields: ['body'] }),
    ).rejects.toThrow(/structural read model/);
    await expect(
      store.ensureIndex(COLLECTION, { kind: 'text', name: 'body', fields: ['body'] }),
    ).rejects.not.toThrow(/kap-server/);

    const peer = new Database(join(homeDir, 'cache', STORE_FILE), { readonly: true });
    try {
      expect(peer.prepare('SELECT sqlite_version() AS version').get()).toMatchObject({
        version: expect.any(String),
      });
      expect(peer.prepare("SELECT json_extract('{\"v\":1}', '$.v') AS value").get()).toMatchObject({
        value: 1,
      });
      const artifacts = peer
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE '%text%' OR sql LIKE '%fts%'")
        .all();
      expect(artifacts).toEqual([]);
    } finally {
      peer.close();
    }

    const storeDir = join(homeDir, 'cache', 'query-store');
    const searchDir = join(homeDir, 'search-index');
    await fsp.mkdir(join(storeDir, 'shard-01'), { recursive: true });
    await fsp.mkdir(searchDir, { recursive: true });
    await fsp.writeFile(join(storeDir, 'shard-01', 'marker'), 'derived');
    await fsp.writeFile(join(searchDir, 'marker'), 'derived');
    const authoritative = join(homeDir, 'sessions', 'workspace', 'session', 'state.json');
    await fsp.mkdir(join(homeDir, 'sessions', 'workspace', 'session'), { recursive: true });
    await fsp.writeFile(authoritative, '{"id":"session"}');

    await expect(store.setCheckpoint('projection', { seq: 1 }, 99)).rejects.toThrow(
      QueryStoreRebuiltError,
    );
    expect(await store.getCheckpoint('projection')).toBeUndefined();
    expect(await backup(store).getCheckpoint('projection')).toBeUndefined();

    await store.setCheckpoint('projection', { seq: 1 });
    expect(await store.getCheckpoint('projection')).toEqual({ seq: 1 });
    expect(await backup(store).getCheckpoint('projection')).toEqual({ seq: 1 });

    const minidb = backup(store);
    const originalSetCheckpoint = minidb.setCheckpoint.bind(minidb);
    let failNextCheckpoint = true;
    minidb.setCheckpoint = async (source, checkpoint) => {
      if (failNextCheckpoint) {
        failNextCheckpoint = false;
        throw new Error('minidb checkpoint failed');
      }
      await originalSetCheckpoint(source, checkpoint);
    };
    await expect(store.setCheckpoint('projection', { seq: 2 })).rejects.toThrow(
      'minidb checkpoint failed',
    );
    expect(await store.getCheckpoint('projection')).toBeUndefined();
    expect(await minidb.getCheckpoint('projection')).toEqual({ seq: 1 });
    await store.setCheckpoint('projection', { seq: 2 });
    expect(await store.getCheckpoint('projection')).toEqual({ seq: 2 });
    expect(await minidb.getCheckpoint('projection')).toEqual({ seq: 2 });

    const primaryEpoch = store.storeEpoch();
    minidb.setCheckpoint = async () => {
      (minidb as unknown as { storeEpochCounter: number }).storeEpochCounter += 1;
      throw new Error('minidb checkpoint rebuilt');
    };
    await expect(store.setCheckpoint('projection', { seq: 3 })).rejects.toThrow(
      'minidb checkpoint rebuilt',
    );
    expect(store.storeEpoch()).toBe(primaryEpoch + 1);
    expect(await store.getCheckpoint('projection')).toBeUndefined();
    minidb.setCheckpoint = originalSetCheckpoint;
    await store.setCheckpoint('projection', { seq: 3 });
    expect(await store.getCheckpoint('projection')).toEqual({ seq: 3 });
    expect(await minidb.getCheckpoint('projection')).toEqual({ seq: 3 });

    expect(await fsp.readFile(join(storeDir, 'shard-01', 'marker'), 'utf8')).toBe('derived');
    expect(await fsp.readFile(join(searchDir, 'marker'), 'utf8')).toBe('derived');
    expect(await fsp.readFile(authoritative, 'utf8')).toBe('{"id":"session"}');
  });

  it('shares connections and rejects stale cross-process checkpoints', async () => {
    const store = build();
    await store.put(COLLECTION, 'seed', { id: 'seed', v: 0 });
    const file = join(homeDir, 'cache', STORE_FILE);
    const peer = new Database(file, { timeout: 1000 });
    try {
      peer.pragma('busy_timeout = 1000');
      expect(peer.pragma('journal_mode', { simple: true })).toBe('wal');
      peer
        .prepare('INSERT INTO query_documents (collection, key, value) VALUES (?, ?, ?)')
        .run(COLLECTION, 'peer', JSON.stringify({ id: 'peer', v: 1 }));
      expect(await store.get(COLLECTION, 'peer')).toEqual({ id: 'peer', v: 1 });
      await store.put(COLLECTION, 'mine', { id: 'mine', v: 2 });
      const row = peer
        .prepare('SELECT value FROM query_documents WHERE collection = ? AND key = ?')
        .get(COLLECTION, 'mine') as { value: string };
      expect(JSON.parse(row.value)).toEqual({ id: 'mine', v: 2 });

      await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byParent', field: 'parent' });
      await store.setCheckpoint('projection', { seq: 1 });
      const staleEpoch = store.storeEpoch();
      const packageEntry = createRequire(import.meta.url).resolve('better-sqlite3');
      const resetScript = join(homeDir, 'reset-store.mjs');
      await fsp.writeFile(
        resetScript,
        `import Database from ${JSON.stringify(pathToFileURL(packageEntry).href)};
const db = new Database(${JSON.stringify(file)});
db.pragma('busy_timeout = 1000');
db.exec('BEGIN IMMEDIATE');
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'qs_%'").all()) {
  db.exec('DROP INDEX "' + name.replaceAll('"', '""') + '"');
}
db.prepare('DELETE FROM query_indexes').run();
db.prepare('DELETE FROM query_numeric_values').run();
db.prepare('DELETE FROM query_documents').run();
db.prepare('UPDATE query_store_metadata SET epoch = epoch + 1 WHERE id = 1').run();
process.stdout.write('locked\\n');
setTimeout(() => {
  db.exec('COMMIT');
  db.close();
}, 100);
`,
      );
      const child = spawn(process.execPath, [resetScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let errors = '';
      child.stderr.on('data', (chunk: Buffer) => {
        errors += chunk.toString();
      });
      const childExit = once(child, 'exit');
      await once(child.stdout, 'data');
      await expect(store.setCheckpoint('projection', { seq: 2 }, staleEpoch)).rejects.toThrow(
        QueryStoreRebuiltError,
      );
      expect(await childExit).toEqual([0, null]);
      expect(errors).toBe('');
      expect(await store.getCheckpoint('projection')).toBeUndefined();
      expect(await backup(store).getCheckpoint('projection')).toEqual({ seq: 1 });
      expect(store.storeEpoch()).toBe(staleEpoch + 1);
      await store.ensureIndex(COLLECTION, { kind: 'value', name: 'byParent', field: 'parent' });
      expect(
        peer
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'qs_value_%'")
          .all(),
      ).toHaveLength(1);
      await store.close();
    } finally {
      peer.close();
    }

    const configured = process.env['KIMI_CODE_SQLITE_NATIVE_BINDING'];
    delete process.env['KIMI_CODE_SQLITE_NATIVE_BINDING'];
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const arch = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
    const getReport = vi.spyOn(process.report, 'getReport').mockReturnValue({ header: {} } as never);
    try {
      const packageEntry = createRequire(import.meta.url).resolve('better-sqlite3');
      expect(sqliteNativeBinding()).toBe(
        join(dirname(packageEntry), '../prebuilds/linuxmusl-x64.node'),
      );
    } finally {
      platform.mockRestore();
      arch.mockRestore();
      getReport.mockRestore();
      if (configured === undefined) delete process.env['KIMI_CODE_SQLITE_NATIVE_BINDING'];
      else process.env['KIMI_CODE_SQLITE_NATIVE_BINDING'] = configured;
    }
  });

  it('resets and rebuilds the store after stored JSON is corrupted', async () => {
    const first = build();
    await first.put(COLLECTION, 'a', { id: 'a', v: 1 });
    await first.ensureIndex(COLLECTION, { kind: 'value', name: 'byV', field: 'v' });
    const firstMiniDb = backup(first);
    const closeMiniDb = firstMiniDb.close.bind(firstMiniDb);
    let miniDbCloseCount = 0;
    firstMiniDb.close = async () => {
      miniDbCloseCount += 1;
      await closeMiniDb();
    };
    await first.close();
    expect(miniDbCloseCount).toBe(1);
    disposeHost?.();
    disposeHost = undefined;
    await drainQueryStoreDisposals();
    expect(miniDbCloseCount).toBe(2);

    const file = join(homeDir, 'cache', STORE_FILE);
    const peer = new Database(file);
    const indexes = peer
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'qs_value_%'")
      .all() as { name: string }[];
    for (const index of indexes) {
      peer.exec(`DROP INDEX "${index.name.replaceAll('"', '""')}"`);
    }
    peer
      .prepare('UPDATE query_documents SET value = ? WHERE collection = ? AND key = ?')
      .run('{ definitely not valid json', COLLECTION, 'a');
    peer.close();

    const second = build();
    await expect(second.get(COLLECTION, 'a')).rejects.toThrow(SyntaxError);
    expect(await second.get(COLLECTION, 'a')).toBeUndefined();
    await second.ensureIndex(COLLECTION, { kind: 'value', name: 'byV', field: 'v' });
    await second.put(COLLECTION, 'b', { id: 'b', v: 2 });
    expect(await backup(second).get(COLLECTION, 'b')).toEqual({ id: 'b', v: 2 });
    const page = await second.query<{ id: string; v: number }>(COLLECTION).where({ v: 2 }).execute();
    expect(page.items).toEqual([{ id: 'b', v: 2 }]);

    await second.close();
    (disposeHost as (() => void) | undefined)?.();
    disposeHost = undefined;
    await fsp.writeFile(file, 'not a sqlite database');
    const third = build();
    await expect(third.get(COLLECTION, 'b')).rejects.toThrow(/SQLITE_NOTADB|not a database/i);
    expect(await third.get(COLLECTION, 'b')).toBeUndefined();
    await third.put(COLLECTION, 'c', { id: 'c', v: 3 });
    expect(await third.get(COLLECTION, 'c')).toEqual({ id: 'c', v: 3 });
    expect(await backup(third).get(COLLECTION, 'c')).toEqual({ id: 'c', v: 3 });
    const artifacts = await fsp.readdir(join(homeDir, 'cache'));
    expect(artifacts.some((name) => name.startsWith(`${STORE_FILE}.corrupt-`))).toBe(true);
  });

  it('resets and rebuilds the store after poison-class or persistent transient failures', async () => {
    const store = build();
    await store.put(COLLECTION, 'a', { id: 'a', v: 1 });
    const internal = store as unknown as { dbPromise: Promise<Database.Database> };
    const failWrites = (db: Database.Database, error: Error): void => {
      const prepare = db.prepare.bind(db);
      (db as unknown as { prepare: unknown }).prepare = (sql: string) => {
        if (sql.includes('INSERT INTO query_documents')) throw error;
        return prepare(sql);
      };
    };
    const db = await internal.dbPromise;
    const poisoned = Object.assign(new Error('poisoned'), { code: 'SQLITE_CORRUPT' });
    failWrites(db, poisoned);
    await expect(store.put(COLLECTION, 'b', { id: 'b', v: 2 })).rejects.toThrow('poisoned');
    expect(await store.get(COLLECTION, 'a')).toBeUndefined();
    await store.put(COLLECTION, 'b', { id: 'b', v: 2 });
    expect(await store.get(COLLECTION, 'b')).toEqual({ id: 'b', v: 2 });

    const db2 = await internal.dbPromise;
    const locked = Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' });
    failWrites(db2, locked);
    for (let i = 0; i < 4; i++) {
      await expect(store.put(COLLECTION, `t${i}`, { v: i })).rejects.toThrow('locked');
      expect(await store.get(COLLECTION, 'b')).toEqual({ id: 'b', v: 2 });
    }
    await expect(store.put(COLLECTION, 'c', { id: 'c', v: 3 })).rejects.toThrow('locked');
    expect(await store.get(COLLECTION, 'b')).toBeUndefined();
    await store.put(COLLECTION, 'c', { id: 'c', v: 3 });
    expect(await store.get(COLLECTION, 'c')).toEqual({ id: 'c', v: 3 });

    const file = join(homeDir, 'cache', STORE_FILE);
    const peer = new Database(file, { timeout: 1000 });
    peer
      .prepare('INSERT INTO query_documents (collection, key, value) VALUES (?, ?, ?)')
      .run(COLLECTION, 'peer', JSON.stringify({ id: 'peer', v: 9 }));
    const beforeReset = await fsp.stat(file);
    const db3 = await internal.dbPromise;
    failWrites(db3, poisoned);
    await expect(store.put(COLLECTION, 'd', { v: 4 })).rejects.toThrow('poisoned');
    expect(peer.open).toBe(true);
    expect((await fsp.stat(file)).ino).toBe(beforeReset.ino);
    expect(peer.prepare('SELECT value FROM query_documents WHERE key = ?').get('peer')).toBeUndefined();
    expect(await store.get(COLLECTION, 'c')).toBeUndefined();
    peer
      .prepare('INSERT INTO query_documents (collection, key, value) VALUES (?, ?, ?)')
      .run(COLLECTION, 'peer-after-reset', JSON.stringify({ id: 'peer-after-reset' }));
    expect(await store.get(COLLECTION, 'peer-after-reset')).toEqual({ id: 'peer-after-reset' });
    peer.close();

    const epoch = store.storeEpoch();
    const db4 = await internal.dbPromise;
    failWrites(db4, poisoned);
    await expect(store.put(COLLECTION, 'e', { v: 5 })).rejects.toThrow('poisoned');
    expect(store.storeEpoch()).toBe(epoch + 1);
    await expect(store.setCheckpoint('projection', { seq: 7 }, epoch)).rejects.toThrow(
      QueryStoreRebuiltError,
    );
    expect(await store.getCheckpoint('projection')).toBeUndefined();
    await store.setCheckpoint('projection', { seq: 7 }, store.storeEpoch());
    expect(await store.getCheckpoint('projection')).toEqual({ seq: 7 });
    expect(await backup(store).getCheckpoint('projection')).toEqual({ seq: 7 });
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

    await store.batch(
      ['a', 'b', 'c'].map((id) => ({
        kind: 'put' as const,
        collection: 'ties',
        key: id,
        value: { id, updatedAt: 7 },
        columns: { updatedAt: 7 },
      })),
    );
    const ties = await store.pageByColumn<{ id: string }>('ties', {
      column: 'updatedAt',
      dir: 'desc',
      limit: 2,
    });
    expect(ties.items.map((item) => item.id)).toEqual(['c', 'b']);
    const internal = store as unknown as { dbPromise: Promise<Database.Database> };
    const db = await internal.dbPromise;
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT d.key, d.value FROM query_numeric_values AS n
         JOIN query_documents AS d ON d.collection = n.collection AND d.key = n.key
         WHERE n.collection = ? AND n.column_name = ?
         ORDER BY n.numeric_value DESC, n.key DESC`,
      )
      .all('ties', 'updatedAt') as { detail: string }[];
    expect(plan.some((step) => step.detail.includes('qs_numeric_page'))).toBe(true);
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

    await store.ensureIndex(COLLECTION, {
      kind: 'value',
      name: 'bySessionParent',
      field: 'custom.parent_session_id',
    });
    await store.put(
      COLLECTION,
      'child',
      {
        id: 'child',
        custom: { parent_session_id: 'p', child_session_kind: 'child' },
        updatedAt: 10,
      },
      { columns: { updatedAt: 10 } },
    );
    const childPage = await store
      .query<{ id: string; updatedAt: number }>(COLLECTION)
      .where({ 'custom.parent_session_id': 'p', 'custom.child_session_kind': 'child' })
      .orderBy('updatedAt', 'desc')
      .limit(10)
      .execute();
    expect(childPage.items.map((item) => item.id)).toEqual(['child']);

    const internal = store as unknown as { dbPromise: Promise<Database.Database> };
    const db = await internal.dbPromise;
    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT key, value FROM query_documents AS d
         WHERE d.collection = ?
           AND json_type(d.value, '$."custom"."parent_session_id"') IS NOT NULL
           AND json_extract(d.value, '$."custom"."parent_session_id"') = ?`,
      )
      .all(COLLECTION, 'p') as { detail: string }[];
    expect(plan.some((step) => step.detail.includes('qs_value_'))).toBe(true);
  });
});
