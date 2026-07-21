import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IQueryStore } from '#/persistence/interface/queryStore';

import { stubFlag } from '../../app/flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';

const META_SCOPE = 'sessions/wd_test/s1/session-meta';

function makeContext(): ISessionContext {
  return makeSessionContext({
    sessionId: 's1',
    workspaceId: 'wd_test',
    sessionDir: '/tmp/sessions/wd_test/s1',
    sessionScope: 'sessions/wd_test/s1',
    metaScope: META_SCOPE,
    cwd: '/tmp/sessions/wd_test/s1',
  });
}

describe('SessionMetadata', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionContext, makeContext());
    ix.stub(IQueryStore, stubQueryStore());
    ix.stub(IFlagService, stubFlag(false));
    ix.set(IFileSystemStorageService, new SyncDescriptor(InMemoryStorageService));
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
  });

  afterEach(() => { disposables.dispose(); });

  it('creates an initial document on first read', async () => {
    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({
      id: 's1',
      archived: false,
      // Seeded so released v1 builds can open a v2-created state.json
      // (v1's Session.resume() indexes `agents` unconditionally).
      agents: {},
      custom: {},
    });
    expect((await meta.read()).createdAt).toBeGreaterThan(0);
  });

  it('update merges fields and bumps updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.update({ title: 'hello' });

    const next = await meta.read();
    expect(next.title).toBe('hello');
    expect(next.updatedAt).toBeGreaterThanOrEqual(before);
  });

  it('setTitle / setArchived write through', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.setTitle('t');
    await meta.setArchived(true);
    expect(await meta.read()).toMatchObject({ title: 't', archived: true });
  });

  it('persists across instances', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'persisted' });

    const fresh = ix.createInstance(SessionMetadata);
    expect(await fresh.read()).toMatchObject({ id: 's1', title: 'persisted' });
  });

  it('backfills and persists missing agents/custom maps on a pre-fix document', async () => {
    // Written by a v2 build predating the create-path map seeding: no
    // agents / custom keys at all.
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({ agents: {}, custom: {} });

    // The heal is persisted: a fresh instance reads the maps from disk, and
    // updatedAt is untouched so session listings keep their order.
    const fresh = ix.createInstance(SessionMetadata);
    const healed = await fresh.read();
    expect(healed.agents).toEqual({});
    expect(healed.custom).toEqual({});
    expect(healed.updatedAt).toBe(1700000000000);
  });

  it('leaves existing agents/custom maps untouched', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: { main: { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' } },
      custom: { cwd: '/tmp/work' },
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({
      agents: { main: { homedir: '/tmp/sessions/wd_test/s1/agents/main', type: 'main' } },
      custom: { cwd: '/tmp/work' },
    });
  });

  it('fires onDidChangeMetadata with the changed keys after update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    let fired = 0;
    let captured: { readonly changed: readonly string[] } | undefined;
    const sub = meta.onDidChangeMetadata((e) => {
      fired++;
      captured = e;
    });
    await meta.update({ title: 'x' });
    expect(fired).toBe(1);
    expect(captured).toEqual({ changed: ['title'] });
    sub.dispose();
  });

  it('preserves every concurrently registered agent', async () => {
    const meta = ix.get(ISessionMetadata);

    await Promise.all([
      meta.registerAgent('agent-0', {
        labels: { swarmItem: 'src/a.ts' },
      }),
      meta.registerAgent('agent-1', {
        labels: { swarmItem: 'src/b.ts' },
      }),
    ]);

    expect(Object.keys((await meta.read()).agents ?? {}).sort()).toEqual([
      'agent-0',
      'agent-1',
    ]);
  });

  it('treats re-registering an unchanged agent as a no-op', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    // A resumed session re-registers its materialized agents; with identical
    // metadata that must not write, bump updatedAt, or fire an event.
    let fired = 0;
    const sub = meta.onDidChangeMetadata(() => {
      fired++;
    });
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    expect(fired).toBe(0);
    expect((await meta.read()).updatedAt).toBe(before);
    sub.dispose();
  });

  it('stays a no-op when re-registering against a persisted document', async () => {
    // The document as it lands on disk: keys with undefined values are gone,
    // and a legacy writer stored parentAgentId: null. A server restart then
    // re-registers `main` with explicit undefineds — still no update.
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: {
        main: {
          homedir: '/tmp/sessions/wd_test/s1/agents/main',
          type: 'main',
          parentAgentId: null,
        },
      },
    });

    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      parentAgentId: undefined,
      forkedFrom: undefined,
      labels: undefined,
    });

    expect((await meta.read()).updatedAt).toBe(1700000000000);
  });

  it('updates when re-registering with changed fields', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
    });
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.registerAgent('main', {
      homedir: '/tmp/sessions/wd_test/s1/agents/main',
      type: 'main',
      labels: { swarmItem: 'src/a.ts' },
    });

    const next = await meta.read();
    expect(next.agents?.['main']?.labels).toEqual({ swarmItem: 'src/a.ts' });
    expect(next.updatedAt).toBeGreaterThan(before);
  });
});
