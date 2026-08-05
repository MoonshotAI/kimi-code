import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import {
  ISessionIndex,
  ISessionIndexMirror,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { recencyColumn, sessionCollection } from '#/app/sessionIndex/sessionIndexModel';
import { FileSessionIndex } from '#/app/sessionIndex/sessionIndexService';
import {
  drainSessionIndexMirror,
  SessionIndexMirror,
} from '#/app/sessionIndex/sessionIndexMirrorService';
import { drainQueryStoreDisposals, MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import {
  IQueryStore,
  type ColumnPageQuery,
  type IQuery,
  type Page,
  type WriteOp,
} from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubSessionIndexMirror } from './stubs';
import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';

const WORK_DIR = '/home/user/repo';

function canonicalIds(summaries: readonly SessionSummary[]): string[] {
  return [...summaries]
    .sort((a, b) => (a.updatedAt !== b.updatedAt ? b.updatedAt - a.updatedAt : a.id < b.id ? 1 : -1))
    .map((s) => s.id);
}

describe('FileSessionIndex (legacy)', () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-'));
    sessionsDir = join(homeDir, 'sessions');
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(): ISessionIndex {
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(IQueryStore, stubQueryStore()),
      stubPair(ISessionIndexMirror, stubSessionIndexMirror()),
      stubPair(IFlagService, stubFlag(false)),
      stubPair(ILogService, stubLog()),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    return host.app.accessor.get(ISessionIndex);
  }

  async function seedSession(
    sessionId: string,
    meta: Record<string, unknown>,
    wsId: string = workspaceId,
  ): Promise<void> {
    const dir = join(sessionsDir, wsId, sessionId, 'session-meta');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  async function seedEmpty(sessionId: string, wsId: string = workspaceId): Promise<void> {
    await fsp.mkdir(join(sessionsDir, wsId, sessionId), { recursive: true });
  }

  it('listRecent returns non-archived sessions by default', async () => {
    await seedSession('active', { createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['active']);
    expect(page.items[0]?.workspaceId).toBe(workspaceId);
    expect(page.items[0]?.archived).toBe(false);
  });

  it('listRecent includes archived when requested', async () => {
    await seedSession('active', {});
    await seedSession('archived', { archived: true });

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId], includeArchived: true });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['active', 'archived']);
  });

  it('get fetches a session by id across workspaces', async () => {
    await seedSession('active', { title: 'hello' });

    const store = build();
    const summary = await store.get('active');
    expect(summary?.id).toBe('active');
    expect(summary?.title).toBe('hello');
    expect(await store.get('missing')).toBeUndefined();
  });

  it('recovers cwd from the metadata document (v2 cwd, v1 workDir, custom.cwd)', async () => {
    await seedSession('v2', { cwd: '/repo/v2' });
    await seedSession('v1', { workDir: '/repo/v1' });
    await seedSession('old', { custom: { cwd: '/repo/old' } });
    await seedSession('none', { title: 'no cwd' });

    const store = build();
    expect((await store.get('v2'))?.cwd).toBe('/repo/v2');
    expect((await store.get('v1'))?.cwd).toBe('/repo/v1');
    expect((await store.get('old'))?.cwd).toBe('/repo/old');
    expect((await store.get('none'))?.cwd).toBeUndefined();
  });

  it('listRecent filters by sessionId without enumerating all sessions', async () => {
    await seedSession('active', { title: 'hello' });
    await seedSession('archived', { archived: true });

    const store = build();
    const active = await store.listRecent({ sessionId: 'active' });
    expect(active.items.map((s) => s.id)).toEqual(['active']);

    const archived = await store.listRecent({ sessionId: 'archived' });
    expect(archived.items).toEqual([]);

    const archivedIncluded = await store.listRecent({
      sessionId: 'archived',
      includeArchived: true,
    });
    expect(archivedIncluded.items.map((s) => s.id)).toEqual(['archived']);
  });

  it('listRecent filters by childOf using the parent_session_id + child_session_kind markers', async () => {
    await seedSession('parent', { createdAt: 1, updatedAt: 10 });
    await seedSession('child-a', {
      createdAt: 2,
      updatedAt: 9,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('child-b', {
      createdAt: 3,
      updatedAt: 8,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('fork', {
      createdAt: 4,
      updatedAt: 7,
      custom: { parent_session_id: 'parent' },
    });
    await seedSession('grandchild', {
      createdAt: 5,
      updatedAt: 6,
      custom: { parent_session_id: 'child-a', child_session_kind: 'child' },
    });

    const store = build();
    const page = await store.listRecent({ childOf: 'parent' });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['child-a', 'child-b']);
  });

  it('count counts non-archived sessions by default and everything with includeArchived', async () => {
    await seedSession('a', {});
    await seedSession('b', {});
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(3);
    expect(await store.count({ workspaceIds: ['wd_unknown'] })).toBe(0);
  });

  it('listRecent merges a workspace-id set into one recency-ordered page', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a1', { createdAt: 1, updatedAt: 1 });
    await seedSession('a3', { createdAt: 3, updatedAt: 3 });
    await seedSession('b2', { createdAt: 2, updatedAt: 2 }, otherId);
    await seedSession('b4', { createdAt: 4, updatedAt: 4 }, otherId);

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId, otherId] });
    expect(page.items.map((s) => s.id)).toEqual(['b4', 'a3', 'b2', 'a1']);
    expect(page.items[0]?.workspaceId).toBe(otherId);
  });

  it('listRecent applies limit after the cross-bucket merge', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a1', { createdAt: 1, updatedAt: 1 });
    await seedSession('a3', { createdAt: 3, updatedAt: 3 });
    await seedSession('b2', { createdAt: 2, updatedAt: 2 }, otherId);

    const store = build();
    const page = await store.listRecent({ workspaceIds: [workspaceId, otherId], limit: 2 });
    expect(page.items.map((s) => s.id)).toEqual(['a3', 'b2']);
    expect(page.nextCursor).toBe('b2');
  });

  it('listRecent filters archived across every bucket of the id set', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('active', {});
    await seedSession('archived', { archived: true }, otherId);

    const store = build();
    const visible = await store.listRecent({ workspaceIds: [workspaceId, otherId] });
    expect(visible.items.map((s) => s.id)).toEqual(['active']);

    const all = await store.listRecent({ workspaceIds: [workspaceId, otherId], includeArchived: true });
    expect(all.items.map((s) => s.id).toSorted()).toEqual(['active', 'archived']);
  });

  it('count sums over the workspace-id set', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a', {});
    await seedSession('b', {}, otherId);
    await seedSession('archived', { archived: true }, otherId);

    const store = build();
    expect(await store.count({ workspaceIds: [workspaceId, otherId] })).toBe(2);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(1);
  });

  it('pages with the before/after keyset cursors', async () => {
    for (let i = 0; i < 5; i++) {
      await seedSession(`s${i}`, { createdAt: i, updatedAt: i });
    }
    const store = build();

    const page1 = await store.listRecent({ workspaceIds: [workspaceId], limit: 2 });
    expect(page1.items.map((s) => s.id)).toEqual(['s4', 's3']);
    expect(page1.nextCursor).toBe('s3');

    const page2 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
      before: page1.nextCursor,
    });
    expect(page2.items.map((s) => s.id)).toEqual(['s2', 's1']);
    expect(page2.nextCursor).toBe('s1');

    const page3 = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 2,
      before: page2.nextCursor,
    });
    expect(page3.items.map((s) => s.id)).toEqual(['s0']);
    expect(page3.nextCursor).toBeUndefined();

    const newer = await store.listRecent({ workspaceIds: [workspaceId], after: 's2' });
    expect(newer.items.map((s) => s.id)).toEqual(['s4', 's3']);

    const unknown = await store.listRecent({ workspaceIds: [workspaceId], before: 'missing' });
    expect(unknown.items).toEqual([]);
    expect(unknown.nextCursor).toBeUndefined();
  });
});

describe('FileSessionIndex (read model)', () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void) | undefined;
  let queryStore: IQueryStore;
  let mirror: ISessionIndexMirror;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      ISessionIndexMirror,
      SessionIndexMirror,
      ScopeActivation.OnDemand,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-rm-'));
    sessionsDir = join(homeDir, 'sessions');
    workspaceId = encodeWorkDirKey(WORK_DIR);
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    // The host's synchronous dispose() fires the mirror drain and the query
    // store's async close; await both so the rm below never races them.
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(
    fileStorage: FileStorageService = new FileStorageService(homeDir),
  ): FileSessionIndex {
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    return host.app.accessor.get(ISessionIndex) as FileSessionIndex;
  }

  async function seedSession(
    sessionId: string,
    meta: Record<string, unknown>,
    wsId: string = workspaceId,
  ): Promise<void> {
    const dir = join(sessionsDir, wsId, sessionId, 'session-meta');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'state.json'), JSON.stringify(meta));
  }

  function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
    return {
      id,
      workspaceId,
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      ...overrides,
    };
  }

  /** Walk every page via `before = nextCursor` and concatenate the ids. */
  async function walkPages(
    store: FileSessionIndex,
    query: { workspaceIds?: readonly string[]; includeArchived?: boolean },
    pageSize: number,
  ): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listRecent({ ...query, limit: pageSize, before: cursor });
      ids.push(...page.items.map((s) => s.id));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return ids;
  }

  // Count `list` calls on the byte layer: once the model is ready, the warm
  // read paths must not enumerate a single session directory.
  class CountingStorage extends FileStorageService {
    listCalls = 0;
    override async list(scope: string, prefix?: string): Promise<readonly string[]> {
      this.listCalls += 1;
      return super.list(scope, prefix);
    }
  }

  interface OpCounts {
    calls: number;
    rows: number;
  }

  // Records, per `method:collection`, how many calls served a read and how
  // many rows came back — the behavioral complexity signal the performance
  // baseline gates on in place of wall-clock budgets.
  class CountingQueryStore extends MiniDbQueryStore {
    private readonly counts = new Map<string, OpCounts>();

    resetCounts(): void {
      this.counts.clear();
    }

    snapshotCounts(): Record<string, OpCounts> {
      return Object.fromEntries([...this.counts.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1)));
    }

    private record(method: string, collection: string, rows: number): void {
      const key = `${method}:${collection}`;
      const entry = this.counts.get(key) ?? { calls: 0, rows: 0 };
      entry.calls += 1;
      entry.rows += rows;
      this.counts.set(key, entry);
    }

    override async get<T>(collection: string, key: string): Promise<T | undefined> {
      const value = await super.get<T>(collection, key);
      this.record('get', collection, value === undefined ? 0 : 1);
      return value;
    }

    override async getMany<T>(
      collection: string,
      keys: readonly string[],
    ): Promise<Map<string, T>> {
      const values = await super.getMany<T>(collection, keys);
      this.record('getMany', collection, values.size);
      return values;
    }

    override async pageByColumn<T>(
      collection: string,
      query: ColumnPageQuery,
    ): Promise<Page<T>> {
      const page = await super.pageByColumn<T>(collection, query);
      this.record('pageByColumn', collection, page.items.length);
      return page;
    }

    override query<T>(collection: string): IQuery<T> {
      const inner = super.query<T>(collection);
      const wrapper: IQuery<T> = {
        where: (filter) => {
          inner.where(filter);
          return wrapper;
        },
        whereColumn: (column, bounds) => {
          inner.whereColumn(column, bounds);
          return wrapper;
        },
        orderBy: (field, dir) => {
          inner.orderBy(field, dir);
          return wrapper;
        },
        limit: (n) => {
          inner.limit(n);
          return wrapper;
        },
        cursor: (cursor) => {
          inner.cursor(cursor);
          return wrapper;
        },
        execute: async () => {
          const page = await inner.execute();
          this.record('query', collection, page.items.length);
          return page;
        },
      };
      return wrapper;
    }

    override async listKeys(collection: string): Promise<readonly string[]> {
      const keys = await super.listKeys(collection);
      this.record('listKeys', collection, keys.length);
      return keys;
    }
  }

  it('prepare projects the persisted sessions and publishes a generation', async () => {
    await seedSession('active', { title: 'hello', createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });

    const store = build();
    expect(store.status()).toEqual({ state: 'uninitialized', degradedCount: 0 });

    const status = await store.prepare();
    expect(status).toEqual({ state: 'ready', generation: 1, degradedCount: 0 });

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['active']);
    expect(page.items[0]?.title).toBe('hello');
    expect(await store.get('active')).toMatchObject({ id: 'active', title: 'hello' });
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(1);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(2);
  });

  it('serves warm reads without touching the session directories', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    const fileStorage = new CountingStorage(homeDir);
    const store = build(fileStorage);
    await store.prepare();

    fileStorage.listCalls = 0;
    const page = await store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    expect(page.items).toHaveLength(2);
    expect(await store.get('a')).toMatchObject({ id: 'a' });
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(fileStorage.listCalls).toBe(0);
  });

  it('paginates exactly through same-millisecond ties', async () => {
    const specs: [string, number][] = [
      ['a', 100],
      ['b', 100],
      ['c', 100],
      ['d', 100],
      ['e', 90],
      ['f', 90],
      ['g', 90],
      ['h', 80],
      ['i', 80],
      ['j', 70],
    ];
    const summaries = specs.map(([id, updatedAt]) => summary(id, { updatedAt }));
    for (const [id, updatedAt] of specs) {
      await seedSession(id, { createdAt: updatedAt - 1, updatedAt });
    }
    const store = build();
    await store.prepare();

    const walked = await walkPages(store, { workspaceIds: [workspaceId] }, 3);
    expect(walked).toEqual(canonicalIds(summaries));
    expect(new Set(walked).size).toBe(specs.length);
  });

  it('listRecent treats a cache entry missing required fields as a cold miss', async () => {
    await seedSession('s1', { title: 'on-disk', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    // Mirrors a poisoned entry written before `archived` was normalized to a
    // boolean (JSON dropped the undefined field entirely).
    const collection = sessionCollection(1);
    await queryStore.put(collection, 's1', {
      id: 's1',
      workspaceId,
      title: 'stale',
      createdAt: 1,
      updatedAt: 2,
    });

    const page = await store.listRecent({ sessionId: 's1' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe('on-disk');
    expect(page.items[0]?.archived).toBe(false);

    // The bad entry is overwritten once the queued mirror re-record flushes.
    await (mirror as SessionIndexMirror).drain();
    const cached = await queryStore.get<SessionSummary>(collection, 's1');
    expect(cached?.archived).toBe(false);
  });

  it('get falls back to disk when the cached entry fails the shape check', async () => {
    await seedSession('s1', { title: 'on-disk', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();
    await queryStore.put(sessionCollection(1), 's1', { id: 's1' });

    const got = await store.get('s1');
    expect(got?.title).toBe('on-disk');
    expect(got?.archived).toBe(false);
  });

  it('walks all pages of a large listing without duplicates', async () => {
    const specs: SessionSummary[] = [];
    for (let i = 0; i < 25; i++) {
      specs.push(summary(`s${String(i).padStart(2, '0')}`, { createdAt: i, updatedAt: i }));
      await seedSession(`s${String(i).padStart(2, '0')}`, { createdAt: i, updatedAt: i });
    }
    const store = build();
    await store.prepare();

    const walked = await walkPages(store, { workspaceIds: [workspaceId] }, 10);
    expect(walked).toEqual(canonicalIds(specs));

    const newer = await store.listRecent({ workspaceIds: [workspaceId], after: 's20' });
    expect(newer.items.map((s) => s.id)).toEqual(['s24', 's23', 's22', 's21']);
  });

  it('listRecent filters by childOf from the read model', async () => {
    await seedSession('child-a', {
      createdAt: 2,
      updatedAt: 9,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('child-b', {
      createdAt: 3,
      updatedAt: 8,
      custom: { parent_session_id: 'parent', child_session_kind: 'child' },
    });
    await seedSession('fork', {
      createdAt: 4,
      updatedAt: 7,
      custom: { parent_session_id: 'parent' },
    });
    await seedSession('grandchild', {
      createdAt: 5,
      updatedAt: 6,
      custom: { parent_session_id: 'child-a', child_session_kind: 'child' },
    });

    const store = build();
    await store.prepare();
    const page = await store.listRecent({ childOf: 'parent' });
    expect(page.items.map((s) => s.id)).toEqual(['child-a', 'child-b']);
  });

  it('listRecent merges a workspace-id set into one recency-ordered page', async () => {
    const otherId = encodeWorkDirKey('/home/user/other');
    await seedSession('a1', { createdAt: 1, updatedAt: 1 });
    await seedSession('a3', { createdAt: 3, updatedAt: 3 });
    await seedSession('b2', { createdAt: 2, updatedAt: 2 }, otherId);
    await seedSession('b4', { createdAt: 4, updatedAt: 4 }, otherId);

    const store = build();
    await store.prepare();
    const page = await store.listRecent({ workspaceIds: [workspaceId, otherId] });
    expect(page.items.map((s) => s.id)).toEqual(['b4', 'a3', 'b2', 'a1']);
    expect(await store.count({ workspaceIds: [workspaceId, otherId] })).toBe(4);
    expect(await store.count({ workspaceIds: [otherId] })).toBe(2);
  });

  it('get falls back to the authoritative document for an un-mirrored session', async () => {
    await seedSession('old', { title: 'projected', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    // Written after the projection: not in the read model, not mirrored.
    await seedSession('fresh', { title: 'from disk', createdAt: 3, updatedAt: 4 });
    const found = await store.get('fresh');
    expect(found?.title).toBe('from disk');
    // The fallback re-records it so the next read is warm.
    expect(mirror.pending().map((s) => s.id)).toContain('fresh');
  });

  it('cursor-less pages merge the mirror queue for read-your-writes', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    const store = build();
    await store.prepare();

    // Recorded but not yet flushed (the mirror flushes on a 100ms timer).
    mirror.record(summary('pending-one', { title: 'pending', createdAt: 3, updatedAt: 10 }));
    const page = await store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    expect(page.items.map((s) => s.id)).toEqual(['pending-one', 'a']);

    await mirror.drain();
    expect(mirror.pending()).toEqual([]);
    const after = await store.listRecent({ workspaceIds: [workspaceId], limit: 20 });
    expect(after.items.map((s) => s.id)).toEqual(['pending-one', 'a']);
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  it('resolves a keyset cursor that is still queued in the mirror', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });
    await seedSession('b', { createdAt: 2, updatedAt: 3 });
    const store = build();
    await store.prepare();

    // The cursor session exists only in the mirror queue (not yet flushed).
    mirror.record(summary('cursor-new', { createdAt: 3, updatedAt: 10 }));
    const first = await store.listRecent({ workspaceIds: [workspaceId], limit: 1 });
    expect(first.items.map((s) => s.id)).toEqual(['cursor-new']);
    expect(first.nextCursor).toBe('cursor-new');

    const rest = await store.listRecent({
      workspaceIds: [workspaceId],
      limit: 5,
      before: first.nextCursor,
    });
    expect(rest.items.map((s) => s.id)).toEqual(['b', 'a']);
    expect(rest.nextCursor).toBeUndefined();

    // An id that is in neither the model nor the queue stays a terminal page.
    const unknown = await store.listRecent({ workspaceIds: [workspaceId], before: 'missing' });
    expect(unknown.items).toEqual([]);
  });

  it('count folds the mirror queue in before the flush lands', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 2 });
    await seedSession('b', { createdAt: 2, updatedAt: 3 });
    const store = build();
    await store.prepare();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);

    // A queued creation counts immediately; a queued archive flip re-buckets.
    mirror.record(summary('new', { createdAt: 3, updatedAt: 4 }));
    mirror.record(summary('a', { archived: true, updatedAt: 5 }));
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(3);

    await mirror.drain();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
    expect(await store.count({ workspaceIds: [workspaceId], includeArchived: true })).toBe(3);
  });

  it('a crashed initial projection falls back to disk and recovers on retry', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 2 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 3 });

    class FlakyQueryStore extends MiniDbQueryStore {
      failNextBatch = false;
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        if (this.failNextBatch) {
          this.failNextBatch = false;
          throw new Error('injected projection crash');
        }
        return super.batch(ops);
      }
    }
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      FlakyQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;

    (queryStore as FlakyQueryStore).failNextBatch = true;
    const status = await store.prepare();
    expect(status.state).toBe('degraded');
    expect(status.degradedCount).toBe(1);
    // Reads still work — from the authoritative documents.
    const fallback = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(fallback.items.map((s) => s.id)).toEqual(['b', 'a']);

    const recovered = await store.prepare();
    expect(recovered).toEqual({ state: 'ready', generation: 1, degradedCount: 1 });
    const warm = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['b', 'a']);
  });

  it('a crashed re-projection keeps readers on the previous generation', async () => {
    await seedSession('a', { createdAt: 1, updatedAt: 3 });
    await seedSession('b', { createdAt: 2, updatedAt: 2 });
    await seedSession('c', { createdAt: 3, updatedAt: 1 });

    class FlakyQueryStore extends MiniDbQueryStore {
      failNextBatch = false;
      override async batch(ops: readonly WriteOp[]): Promise<void> {
        if (this.failNextBatch) {
          this.failNextBatch = false;
          throw new Error('injected projection crash');
        }
        return super.batch(ops);
      }
    }
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      FlakyQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new FileStorageService(homeDir);
    const host = createScopedTestHost([
      stubPair(IFileSystemStorageService, fileStorage),
      stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
    mirror = host.app.accessor.get(ISessionIndexMirror);
    const store = host.app.accessor.get(ISessionIndex) as FileSessionIndex;
    await store.prepare();
    expect(store.status().state).toBe('ready');

    // The authoritative set changes, then the re-projection dies mid-write.
    await fsp.rm(join(sessionsDir, workspaceId, 'b'), { recursive: true, force: true });
    (queryStore as FlakyQueryStore).failNextBatch = true;
    await store.reprojectNow();

    // Readers never noticed the crash: generation 1 is still served, with the
    // session that no longer exists on disk.
    expect(store.status()).toEqual({ state: 'ready', generation: 1, degradedCount: 0 });
    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['a', 'b', 'c']);

    await store.reprojectNow();
    expect(store.status()).toEqual({ state: 'ready', generation: 2, degradedCount: 0 });
    const rebuilt = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(rebuilt.items.map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('reprojects automatically after the store is wiped, without per-request backfill', async () => {
    await seedSession('a', { title: 'a', createdAt: 1, updatedAt: 3 });
    await seedSession('b', { title: 'b', createdAt: 2, updatedAt: 2 });

    const first = build();
    await first.prepare();
    expect(first.status().state).toBe('ready');

    // Simulate a corruption rebuild: the whole query-store directory is wiped
    // (minidb's own rebuild machinery is covered in its package tests).
    disposeHost?.();
    disposeHost = undefined;
    await drainSessionIndexMirror();
    await drainQueryStoreDisposals();
    await fsp.rm(join(homeDir, 'cache', 'query-store'), { recursive: true, force: true });

    const second = build();
    // The first read falls back to the authoritative documents and kicks the
    // reprojection; once ready, the model is complete again.
    const fallback = await second.listRecent({ workspaceIds: [workspaceId] });
    expect(fallback.items.map((s) => s.id)).toEqual(['a', 'b']);
    const status = await second.prepare();
    expect(status.state).toBe('ready');
    const warm = await second.listRecent({ workspaceIds: [workspaceId] });
    expect(warm.items.map((s) => s.id)).toEqual(['a', 'b']);
    expect(await second.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  it('reconciliation repairs external edits and deletions of state.json', async () => {
    await seedSession('keep', { title: 'before', createdAt: 1, updatedAt: 3 });
    await seedSession('archived', { createdAt: 2, updatedAt: 2 });
    await seedSession('gone', { createdAt: 3, updatedAt: 1 });

    const store = build();
    await store.prepare();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(3);

    // External modification and deletion, behind the mirror's back.
    await seedSession('keep', { title: 'after', createdAt: 1, updatedAt: 4 });
    await fsp.rm(join(sessionsDir, workspaceId, 'gone'), { recursive: true, force: true });
    await store.reconcileNow();

    const page = await store.listRecent({ workspaceIds: [workspaceId] });
    expect(page.items.map((s) => s.id)).toEqual(['keep', 'archived']);
    expect(page.items[0]?.title).toBe('after');
    expect(await store.get('gone')).toBeUndefined();
    expect(await store.count({ workspaceIds: [workspaceId] })).toBe(2);
  });

  // -- stage-3 performance baselines ------------------------------------------
  // Medians are logged as JSON for phase-to-phase comparison, but no
  // wall-clock budget gates CI: shared-runner load can inflate any fixed
  // threshold past itself (list medians of 100-140ms were observed on
  // otherwise green builds). The asserted guard is behavioral complexity:
  // every warm read must touch a bounded number of store rows and zero
  // session directories, and that work must be identical at 1k, 10k, and 50k
  // sessions — a linear regression changes the counts deterministically, on
  // any runner. The single retry absorbs a background reconcile tick (60s
  // interval) landing inside a counting window.
  const baseline = { retry: 1, timeout: 120_000 };

  it('baseline: warm listRecent(limit=20) at 1k vs 10k vs 50k sessions', baseline, async () => {
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      CountingQueryStore,
      ScopeActivation.OnDemand,
      'storage',
    );
    const fileStorage = new CountingStorage(homeDir);
    const store = build(fileStorage);
    const countingStore = queryStore as CountingQueryStore;
    // A small on-disk seed publishes generation 1; scale rows are written
    // directly into the generation (the mirror path is covered elsewhere).
    await seedSession('seed', { createdAt: 0, updatedAt: 0 });
    await store.prepare();
    const collection = sessionCollection(1);

    const seedRows = async (from: number, to: number): Promise<void> => {
      for (let start = from; start < to; start += 500) {
        const ops = [];
        for (let i = start; i < Math.min(start + 500, to); i++) {
          ops.push({
            kind: 'put' as const,
            collection,
            key: `s${i}`,
            value: {
              ...summary(`s${i}`, { title: `session ${i}`, createdAt: i, updatedAt: i + 1 }),
              [recencyColumn(1)]: i + 1,
            },
            columns: { [recencyColumn(1)]: i + 1 },
          });
        }
        await queryStore.batch(ops);
      }
    };
    const median = async (run: () => Promise<unknown>, repeats = 5): Promise<number> => {
      const runs: number[] = [];
      for (let r = 0; r < repeats; r++) {
        const t0 = performance.now();
        await run();
        runs.push(performance.now() - t0);
      }
      runs.sort((a, b) => a - b);
      return runs[(runs.length / 2) | 0]!;
    };

    const LIST_LIMIT = 20;
    const listPage = async () => {
      const page = await store.listRecent({ workspaceIds: [workspaceId], limit: LIST_LIMIT });
      expect(page.items).toHaveLength(LIST_LIMIT);
    };
    const getOne = () => store.get('s0');
    const countAll = () => store.count({ workspaceIds: [workspaceId] });

    // One counted run per op (which store methods served it, how many rows
    // they returned, how many directory listings happened underneath), then
    // the timed repeats that feed the log line.
    const measure = async () => {
      const countOp = async (op: () => Promise<unknown>) => {
        countingStore.resetCounts();
        const listed = fileStorage.listCalls;
        await op();
        return { counts: countingStore.snapshotCounts(), fsLists: fileStorage.listCalls - listed };
      };
      const ops = {
        list: await countOp(listPage),
        get: await countOp(getOne),
        count: await countOp(countAll),
      };
      const list = await median(listPage);
      const get = await median(getOne);
      const count = await median(countAll);
      return { ops, list, get, count };
    };

    await seedRows(0, 1_000);
    const at1k = await measure();
    await seedRows(1_000, 10_000);
    const at10k = await measure();
    await seedRows(10_000, 50_000);
    const at50k = await measure();
    console.log(
      `[baseline] sessionIndex read-model ${JSON.stringify({ sessions: [1000, 10000, 50000], list: [at1k.list, at10k.list, at50k.list], get: [at1k.get, at10k.get, at50k.get], count: [at1k.count, at10k.count, at50k.count] })}`,
    );

    const sessionOps = (counts: Record<string, OpCounts>): string[] =>
      Object.keys(counts).filter((key) => key.endsWith(`:${collection}`));
    const sessionRows = (counts: Record<string, OpCounts>): number =>
      sessionOps(counts).reduce((total, key) => total + counts[key]!.rows, 0);

    for (const measured of [at1k, at10k, at50k]) {
      // No warm read falls back to the authoritative directory scan.
      for (const op of Object.values(measured.ops)) expect(op.fsLists).toBe(0);
      // list is served by bounded ordered-column fetches only — no full
      // scans, no per-row point reads; the rows touched stay within the page
      // window plus its tie-repair fetch.
      expect(sessionOps(measured.ops.list.counts)).toEqual([`pageByColumn:${collection}`]);
      expect(sessionRows(measured.ops.list.counts)).toBeLessThanOrEqual(2 * (LIST_LIMIT + 1));
      // get is a single point lookup.
      expect(measured.ops.get.counts[`get:${collection}`]).toEqual({ calls: 1, rows: 1 });
      expect(sessionOps(measured.ops.get.counts)).toEqual([`get:${collection}`]);
      // count reads the materialized counters, never the sessions themselves.
      expect(sessionOps(measured.ops.count.counts)).toEqual([]);
    }
    // The complexity gate: 50x the rows must not change the work at all.
    expect(at10k.ops).toEqual(at1k.ops);
    expect(at50k.ops).toEqual(at1k.ops);
  });
});
