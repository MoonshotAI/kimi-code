import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MiniDb } from '@moonshot-ai/minidb';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { FileSessionIndex } from '#/app/sessionIndex/sessionIndexService';
import { MiniDbQueryStore } from '#/persistence/backends/minidb/miniDbQueryStore';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IQueryStore } from '#/persistence/interface/queryStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { stubBootstrap } from '../bootstrap/stubs';
import { stubFlag } from '../flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';

const WORK_DIR = '/home/user/repo';
const SESSION_COLLECTION = 'session';

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
      InstantiationType.Delayed,
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

  it('list returns non-archived sessions by default', async () => {
    await seedSession('active', { createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    const page = await store.list({ workspaceId });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['active']);
    expect(page.items[0]?.workspaceId).toBe(workspaceId);
    expect(page.items[0]?.archived).toBe(false);
  });

  it('list includes archived when requested', async () => {
    await seedSession('active', {});
    await seedSession('archived', { archived: true });

    const store = build();
    const page = await store.list({ workspaceId, includeArchived: true });
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

  it('list filters by sessionId without enumerating all sessions', async () => {
    await seedSession('active', { title: 'hello' });
    await seedSession('archived', { archived: true });

    const store = build();
    const active = await store.list({ sessionId: 'active' });
    expect(active.items.map((s) => s.id)).toEqual(['active']);

    const archived = await store.list({ sessionId: 'archived' });
    expect(archived.items).toEqual([]);

    const archivedIncluded = await store.list({ sessionId: 'archived', includeArchived: true });
    expect(archivedIncluded.items.map((s) => s.id)).toEqual(['archived']);
  });

  it('list filters by childOf using the parent_session_id + child_session_kind markers', async () => {
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
    const page = await store.list({ childOf: 'parent' });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['child-a', 'child-b']);
  });

  it('countActive counts non-archived sessions', async () => {
    await seedSession('a', {});
    await seedSession('b', {});
    await seedSession('archived', { archived: true });
    await seedEmpty('no-state');

    const store = build();
    expect(await store.countActive(workspaceId)).toBe(2);
    expect(await store.countActive('wd_unknown')).toBe(0);
  });
});

describe('FileSessionIndex (read model)', () => {
  let homeDir: string;
  let sessionsDir: string;
  let workspaceId: string;
  let disposeHost: (() => void) | undefined;
  let queryStore: IQueryStore;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      ISessionIndex,
      FileSessionIndex,
      InstantiationType.Delayed,
      'sessionIndex',
    );
    registerScopedService(
      LifecycleScope.App,
      IQueryStore,
      MiniDbQueryStore,
      InstantiationType.Delayed,
      'storage',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'ws-sessions-rm-'));
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
      stubPair(ILogService, stubLog()),
      stubPair(IFlagService, stubFlag(true)),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    queryStore = host.app.accessor.get(IQueryStore);
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

  it('list backfills from disk on a cold read model, then serves from it', async () => {
    await seedSession('active', { title: 'hello', createdAt: 1, updatedAt: 2 });
    await seedSession('archived', { archived: true });

    const store = build();
    const first = await store.list({ workspaceId });
    expect(first.items.map((s) => s.id)).toEqual(['active']);
    expect(first.items[0]?.title).toBe('hello');

    await queryStore.put(
      SESSION_COLLECTION,
      'active',
      summary('active', { title: 'renamed', updatedAt: 3 }),
    );
    const second = await store.list({ workspaceId });
    expect(second.items[0]?.title).toBe('renamed');
  });

  it('get prefers the read model over disk', async () => {
    const store = build();
    await queryStore.put(SESSION_COLLECTION, 'warm', summary('warm', { title: 'cached' }));
    const got = await store.get('warm');
    expect(got?.title).toBe('cached');
  });

  it('list filters by childOf from the read model', async () => {
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
    const page = await store.list({ childOf: 'parent' });
    expect(page.items.map((s) => s.id).toSorted()).toEqual(['child-a', 'child-b']);
  });

  it('countActive reflects read-model updates', async () => {
    await seedSession('a', {});
    await seedSession('b', { archived: true });

    const store = build();
    expect(await store.countActive(workspaceId)).toBe(1);

    await queryStore.put(SESSION_COLLECTION, 'a', summary('a', { archived: true }));
    expect(await store.countActive(workspaceId)).toBe(0);
  });

  it('falls back to the legacy disk path when the query store is locked', async () => {
    await seedSession('active', { title: 'from disk', createdAt: 1, updatedAt: 2 });

    const lockHolder = await MiniDb.open({
      dir: join(homeDir, 'cache', 'query-store'),
      valueCodec: 'json',
    });
    const warnings: string[] = [];
    const log = { ...stubLog(), warn: (msg: string) => { warnings.push(msg); } };
    try {
      const fileStorage = new FileStorageService(homeDir);
      const host = createScopedTestHost([
        stubPair(IFileSystemStorageService, fileStorage),
        stubPair(IAtomicDocumentStore, new JsonAtomicDocumentStore(fileStorage)),
        stubPair(IBootstrapService, stubBootstrap(homeDir)),
        stubPair(ILogService, log),
        stubPair(IFlagService, stubFlag(true)),
      ]);
      disposeHost = () => { host.dispose(); };
      const store = host.app.accessor.get(ISessionIndex);
      const page = await store.list({ workspaceId });
      expect(page.items.map((s) => s.id)).toEqual(['active']);
      expect(page.items[0]?.title).toBe('from disk');
      expect(await store.get('active')).toMatchObject({ id: 'active', title: 'from disk' });
      expect(await store.countActive(workspaceId)).toBe(1);
      expect(warnings).toEqual(['query-store locked by another process; disabling read model']);
    } finally {
      await lockHolder.close();
    }
  });
});
