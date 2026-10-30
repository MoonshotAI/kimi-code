import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { IEventService } from '#/app/event/event';
import type { Event2 } from '#/app/event/event2';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata, type SessionMeta } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { applyPromptMetadataUpdate } from '#/session/sessionMetadata/promptMetadata';
import { SessionMetaUpdated } from '#/session/sessionMetadata/sessionMetaEvents';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { InMemorySessionLockService } from '#/persistence/backends/memory/sessionLockService';
import { ISessionLockService } from '#/persistence/interface/sessionLock';

import { stubSessionIndexMirror } from '../../app/sessionIndex/stubs';
import { stubLog } from '../../_base/log/stubs';

const META_SCOPE = 'sessions/wd_test/s1/session-meta';

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

function recordSessionMetaUpdates(): {
  readonly eventService: IEventService;
  readonly published: SessionMetaUpdated[];
} {
  const published: SessionMetaUpdated[] = [];
  const emitter = new Emitter<Event2>();
  return {
    published,
    eventService: {
      _serviceBrand: undefined,
      onDidPublish: emitter.event,
      publish: (event) => {
        published.push(event as SessionMetaUpdated);
      },
      subscribe: (handler) => emitter.event(handler),
    },
  };
}

describe('SessionMetadata', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mirror: ReturnType<typeof stubSessionIndexMirror>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    mirror = stubSessionIndexMirror();
    ix.stub(ILogService, stubLog());
    ix.stub(ISessionContext, makeContext());
    ix.stub(ISessionIndexMirror, mirror);
    const locks = new InMemorySessionLockService();
    ix.stub(ISessionLockService, locks);
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
      agents: {},
      custom: {},
    });
    expect((await meta.read()).createdAt).toBeGreaterThan(0);
  });

  it('retains the host cwd in metadata and the read model for a remote session', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ environmentId: 'remote', environmentCwd: '/remote/project' });
    expect((await meta.read()).cwd).toBe(makeContext().cwd);
    expect(mirror.recorded.at(-1)).toMatchObject({ cwd: makeContext().cwd });
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

  it('update with touchUpdatedAt:false keeps the previous updatedAt', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await meta.update({ title: 'quiet' }, { touchUpdatedAt: false });

    const next = await meta.read();
    expect(next.title).toBe('quiet');
    expect(next.updatedAt).toBe(before);
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

  it('setTitle keeps updatedAt (rename must not reorder listings)', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.setTitle('renamed');

    const next = await meta.read();
    expect(next.title).toBe('renamed');
    expect(next.updatedAt).toBe(before);
  });

  it('setArchived records archivedAt without touching updatedAt; restore clears it', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    await meta.setArchived(true);
    const archived = await meta.read();
    expect(archived.archived).toBe(true);
    expect(archived.archivedAt).toBeGreaterThan(before);
    expect(archived.updatedAt).toBe(before);

    await meta.setArchived(false);
    const restored = await meta.read();
    expect(restored.archived).toBe(false);
    expect(restored.archivedAt).toBeUndefined();
    expect(restored.updatedAt).toBe(before);
  });

  it('registerAgent never bumps updatedAt — the agents map is structural', async () => {
    const meta = ix.get(ISessionMetadata);
    const before = (await meta.read()).updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await meta.registerAgent('main', { homedir: '/tmp/h', type: 'main' });

    const next = await meta.read();
    expect(next.agents?.['main']?.homedir).toBe('/tmp/h');
    expect(next.updatedAt).toBe(before);
  });

  it('an explicit patch.updatedAt always wins (fork inherits the source recency)', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'fork', updatedAt: 1234 });

    const next = await meta.read();
    expect(next.title).toBe('fork');
    expect(next.updatedAt).toBe(1234);
  });

  it('reads a loaded document without the archived field as not-archived', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    expect(await meta.read()).toMatchObject({ id: 's1', archived: false });
  });

  it('mirrors a boolean archived to the read model even when the loaded document lacks the field', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toEqual([]);

    await meta.update({ title: 'x' });

    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]).toMatchObject({ id: 's1', archived: false });
  });

  it('persists the authoritative document before recording to the mirror', async () => {
    const store = ix.get(IAtomicDocumentStore);
    const persistedAtRecord: Promise<Record<string, unknown> | undefined>[] = [];
    const baseRecord = mirror.record;
    mirror.record = (summary) => {
      persistedAtRecord.push(store.get<Record<string, unknown>>(META_SCOPE, 'state.json'));
      baseRecord(summary);
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ title: 'durable-first' });

    expect(persistedAtRecord).toHaveLength(2);
    const [atCreate, atUpdate] = await Promise.all(persistedAtRecord);
    expect(atCreate).toMatchObject({ id: 's1', archived: false });
    expect(atUpdate).toMatchObject({ title: 'durable-first' });
  });

  it('a mirror failure degrades the read model but never fails the metadata mutation', async () => {
    mirror.record = () => {
      throw new Error('mirror down');
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    await meta.update({ title: 'still fine' });
    expect(await meta.read()).toMatchObject({ title: 'still fine' });

    const fresh = createFreshMetadata(ix);
    expect(await fresh.read()).toMatchObject({ title: 'still fine' });
  });

  it('persists across instances', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.update({ title: 'persisted' });

    const fresh = createFreshMetadata(ix);
    expect(await fresh.read()).toMatchObject({ id: 's1', title: 'persisted' });
  });

  it('backfills and persists missing agents/custom maps on a pre-fix document', async () => {
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

    const persisted = await store.get<Record<string, unknown>>(META_SCOPE, 'state.json');
    expect(persisted).toMatchObject({ titleKind: 'custom', isCustomTitle: true });

    const fresh = createFreshMetadata(ix);
    await expect(fresh.read()).resolves.toMatchObject({
      title: '用户手工标题',
      titleKind: 'custom',
    });
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

    expect(Object.keys((await meta.read()).agents ?? {}).toSorted()).toEqual([
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

  it('updates changed fields on re-registration without bumping updatedAt', async () => {
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
    expect(next.updatedAt).toBe(before);
  });

  it('records the fresh summary into the session index mirror on update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toHaveLength(1);

    await meta.update({ title: 'mirrored' });

    expect(mirror.recorded).toHaveLength(2);
    expect(mirror.recorded[1]).toMatchObject({
      id: 's1',
      workspaceId: 'wd_test',
      title: 'mirrored',
      archived: false,
    });
    expect(mirror.recorded[1]?.updatedAt).toBe((await meta.read()).updatedAt);
  });

  it('does not re-record when loading an existing document', async () => {
    const store = ix.get(IAtomicDocumentStore);
    await store.set(META_SCOPE, 'state.json', {
      id: 's1',
      version: 2,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      archived: false,
      agents: {},
      custom: {},
    });

    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    expect(mirror.recorded).toEqual([]);

    await meta.setArchived(true);
    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]?.archived).toBe(true);
  });

  it('re-reads state.json when the lock was re-acquired after an external write', async () => {
    const meta = ix.get(ISessionMetadata);
    const locks = ix.get(ISessionLockService);
    const store = ix.get(IAtomicDocumentStore);
    await meta.setTitle('mine');

    locks.release('s1');
    const current = await store.get<SessionMeta>(META_SCOPE, 'state.json');
    await store.set(META_SCOPE, 'state.json', {
      ...current!,
      title: 'theirs',
      updatedAt: Date.now(),
    });

    await meta.update({ lastPrompt: 'hello' });

    const persisted = await store.get<SessionMeta>(META_SCOPE, 'state.json');
    expect(persisted?.title).toBe('theirs');
    expect(persisted?.lastPrompt).toBe('hello');
  });

  it('holds an explicit lease while writing state.json', async () => {
    const meta = ix.get(ISessionMetadata);
    const locks = ix.get(ISessionLockService);
    const store = ix.get(IAtomicDocumentStore);
    await meta.read();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSet = store.set.bind(store);
    vi.spyOn(store, 'set').mockImplementation(async (...args: Parameters<typeof store.set>) => {
      await gate;
      return realSet(...args);
    });

    const writing = meta.setTitle('held');
    await vi.waitFor(() => {
      expect(store.set).toHaveBeenCalled();
    });
    locks.release('s1');
    expect(locks.held('s1')).toBe(true);
    release();
    await writing;
    expect(locks.held('s1')).toBe(false);
    expect((await meta.read()).title).toBe('held');
  });

  describe('applyPromptMetadataUpdate', () => {
    it('derives a title and preserves a later custom title from another client', async () => {
      const meta = ix.get(ISessionMetadata);
      const locks = ix.get(ISessionLockService);
      const store = ix.get(IAtomicDocumentStore);
      await meta.ready;

      const { eventService, published } = recordSessionMetaUpdates();
      await applyPromptMetadataUpdate(
        { metadata: meta, eventService, sessionId: 's1' },
        'first prompt',
      );
      expect(await store.get<SessionMeta>(META_SCOPE, 'state.json')).toMatchObject({
        title: 'first prompt',
        titleKind: 'replaceable',
        lastPrompt: 'first prompt',
      });

      locks.release('s1');
      const current = await store.get<SessionMeta>(META_SCOPE, 'state.json');
      await store.set(META_SCOPE, 'state.json', {
        ...current!,
        title: 'renamed elsewhere',
        titleKind: 'custom',
        isCustomTitle: true,
        updatedAt: Date.now(),
      });
      await applyPromptMetadataUpdate(
        { metadata: meta, eventService, sessionId: 's1' },
        'second prompt',
      );

      expect(await store.get<SessionMeta>(META_SCOPE, 'state.json')).toMatchObject({
        title: 'renamed elsewhere',
        titleKind: 'custom',
        lastPrompt: 'second prompt',
      });
      expect(
        published.map((event) => ({ title: event.payload.title, patch: event.payload.patch })),
      ).toEqual([
        {
          title: 'first prompt',
          patch: { title: 'first prompt', isCustomTitle: false, lastPrompt: 'first prompt' },
        },
        {
          title: undefined,
          patch: { title: undefined, isCustomTitle: undefined, lastPrompt: 'second prompt' },
        },
      ]);
    });
  });
});
