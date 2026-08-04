import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { TestInstantiationService } from '#/_base/di/test';
import { IFlagService } from '#/app/flag/flag';
import { ILogService } from '#/_base/log/log';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IQueryStore } from '#/persistence/interface/queryStore';

import { stubFlag } from '../../app/flag/stubs';
import { stubLog } from '../../_base/log/stubs';
import { stubQueryStore } from '../../persistence/interface/stubs';

const META_SCOPE = 'sessions/wd_test/s1/session-meta';

// A re-constructed SessionMetadata stands for a new session lifetime: it gets
// its own state registry, so the shared `sessionMetadata.data` key registers
// cleanly instead of colliding with the first instance's registration.
function createFreshMetadata(ix: TestInstantiationService): SessionMetadata {
  return ix
    .createChild(new ServiceCollection([ISessionStateService, new SessionStateService()]))
    .createInstance(SessionMetadata);
}

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
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
    ix.set(IFileSystemStorageService, new SyncDescriptor(InMemoryStorageService));
    ix.set(IAtomicDocumentStore, new SyncDescriptor(JsonAtomicDocumentStore));
    ix.set(ISessionMetadata, new SyncDescriptor(SessionMetadata));
  });

  afterEach(() => {
    disposables.dispose();
    vi.restoreAllMocks();
  });

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
    expect(await meta.read()).toMatchObject({ title: 't', titleKind: 'custom', archived: true });
  });

  it('sets a generated title while the metadata remains uncustomized', async () => {
    const meta = ix.get(ISessionMetadata);

    await expect(meta.setGeneratedTitleIfUncustomized('generated title')).resolves.toBe(true);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'generated title',
      titleKind: 'generated',
    });
  });

  it('mirrors a boolean archived to the read model even when the loaded document lacks the field', async () => {
    // A state.json written before `archived` existed: normalizeSessionMeta
    // keeps the field undefined, and a naive mirror would drop the key from
    // the cached JSON entirely (failing the read-model contract on reads).
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const writes: unknown[] = [];
    ix.stub(IQueryStore, {
      ...stubQueryStore(),
      put: async (_c: string, _k: string, value: unknown) => {
        writes.push(value);
      },
    });
    ix.stub(IFlagService, stubFlag(true));

    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'x' });

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: 's1', archived: false });
  });

  it('persists across instances', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'persisted' });

    const fresh = createFreshMetadata(ix);
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
    const fresh = createFreshMetadata(ix);
    const healed = await fresh.read();
    expect(healed.agents).toEqual({});
    expect(healed.custom).toEqual({});
    expect(healed.updatedAt).toBe(1700000000000);
  });

  it('normalizes the legacy customTitle field before callers read metadata', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      customTitle: 'legacy title',
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'legacy title',
      titleKind: 'custom',
    });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: 'legacy title',
      titleKind: 'custom',
    });
  });

  it('trusts modern custom title state over a stale legacy customTitle', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'renamed title',
      isCustomTitle: true,
      customTitle: 'legacy custom title',
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'renamed title',
      titleKind: 'custom',
    });

    await meta.update({ archived: true });
    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: 'renamed title',
      titleKind: 'custom',
      archived: true,
    });
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    // The v1-readable marker is double-written (derived from titleKind);
    // only the pre-`isCustomTitle` legacy field is stripped.
    expect(persisted).toMatchObject({ isCustomTitle: true });
    expect(persisted).not.toHaveProperty('customTitle');
  });

  it('migrates a legacy non-custom title to replaceable title state', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'prompt title',
      isCustomTitle: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);

    await expect(meta.read()).resolves.toMatchObject({
      title: 'prompt title',
      titleKind: 'replaceable',
    });
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({
      title: 'prompt title',
      titleKind: 'replaceable',
      isCustomTitle: false,
    });
  });

  it('honors a legacy writer custom marker over the stale titleKind it left behind', async () => {
    // The mixed-version round trip: v2 persists a replaceable title, then a
    // released v1 build renames the session — its writer spreads the original
    // document, so `isCustomTitle: true` lands next to the stale
    // `titleKind: 'replaceable'`. The explicit custom marker must win, or the
    // next auto generation would overwrite the user's title.
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: '用户手工标题',
      titleKind: 'replaceable',
      isCustomTitle: true,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });

    // The heal persists the upgraded state — v1 keeps reading it as custom.
    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ titleKind: 'custom', isCustomTitle: true });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });
    // A generated title must not replace the upgraded custom title.
    await expect(fresh.setGeneratedTitleIfUncustomized('generated title')).resolves.toBe(false);
  });

  it('double-writes the derived isCustomTitle marker for v1 readers', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const meta = ix.get(ISessionMetadata);

    await meta.setGeneratedTitleIfUncustomized('generated title');
    await expect(store.get<Record<string, unknown>>(META_SCOPE, 'state.json')).resolves.toMatchObject(
      { titleKind: 'generated', isCustomTitle: false },
    );

    await meta.setTitle('user title');
    await expect(store.get<Record<string, unknown>>(META_SCOPE, 'state.json')).resolves.toMatchObject(
      { titleKind: 'custom', isCustomTitle: true },
    );
  });

  it('does not downgrade a modern titleKind on a legacy false marker', async () => {
    // The double-written pair as this build persists it: the `false` marker
    // is informational and must not demote the generated state.
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: 'generated title',
      titleKind: 'generated',
      isCustomTitle: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'generated title',
      titleKind: 'generated',
    });
  });

  it.each([
    // [document title fields, expected titleKind] — the mixed-version matrix.
    [{ isCustomTitle: true, titleKind: 'generated' as const }, 'custom'],
    [{ isCustomTitle: true, titleKind: 'replaceable' as const }, 'custom'],
    [{ isCustomTitle: true }, 'custom'],
    [{ isCustomTitle: false, titleKind: 'custom' as const }, 'custom'],
    [{ isCustomTitle: false, titleKind: 'generated' as const }, 'generated'],
    [{ isCustomTitle: false }, 'replaceable'],
    [{ titleKind: 'generated' as const }, 'generated'],
    [{ customTitle: 'legacy title' }, 'custom'],
    [{}, 'replaceable'],
  ])('normalizes title state %j to titleKind %s', async (fields, expectedKind) => {
    const store = ix.get(IAtomicDocumentStore);
    const title = 'customTitle' in fields ? undefined : 'some title';
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      ...(title === undefined ? {} : { title }),
      ...fields,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    expect((await meta.read()).titleKind).toBe(expectedKind);
  });

  it('migrates the title state once, not on every load', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      title: '用户手工标题',
      titleKind: 'replaceable',
      isCustomTitle: true,
      agents: {},
      custom: {},
    });

    const first = ix.get(ISessionMetadata);
    await first.ready;
    const setSpy = vi.spyOn(store, 'set');
    const fresh = createFreshMetadata(ix);
    await fresh.ready;

    // The first load already healed the document; the second load sees a
    // consistent pair and must not write again.
    expect(setSpy).not.toHaveBeenCalled();
    expect((await fresh.read()).titleKind).toBe('custom');
  });

  it('keeps a queued custom title when a generated title is enqueued afterward', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    const store = ix.get(IAtomicDocumentStore);
    const set = store.set.bind(store);
    let releaseWrite: (() => void) | undefined;
    let markWriteStarted: (() => void) | undefined;
    const writeStarted = new Promise<void>((resolve) => {
      markWriteStarted = resolve;
    });
    const writeReleased = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let shouldBlock = true;
    vi.spyOn(store, 'set').mockImplementation(async (scope, key, value) => {
      if (shouldBlock) {
        shouldBlock = false;
        markWriteStarted?.();
        await writeReleased;
      }
      await set(scope, key, value);
    });

    const priorWrite = meta.update({ lastPrompt: 'hello' });
    await writeStarted;
    const rename = meta.setTitle('user title');
    const generated = meta.setGeneratedTitleIfUncustomized('generated title');
    releaseWrite?.();

    await priorWrite;
    await rename;
    await expect(generated).resolves.toBe(false);
    await expect(meta.read()).resolves.toMatchObject({
      title: 'user title',
      titleKind: 'custom',
    });
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
