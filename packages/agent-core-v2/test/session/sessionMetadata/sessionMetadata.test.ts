import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { ServiceCollection } from '#/_base/di/serviceCollection';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { ISessionIndexMirror } from '#/app/sessionIndex/sessionIndex';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { SessionMetadata } from '#/session/sessionMetadata/sessionMetadataService';
import { ISessionStateService } from '#/session/state/sessionState';
import { SessionStateService } from '#/session/state/sessionStateService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';

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
    ix.set(ISessionStateService, new SyncDescriptor(SessionStateService));
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
    expect(await meta.read()).toMatchObject({ title: 't', archived: true });
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
    // A genuinely NEW agent (resume materializing a cold session's main
    // agent, or a runtime subagent) is not content activity.
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
    // A resume loads silently; only mutations reach the mirror.
    expect(mirror.recorded).toEqual([]);

    await meta.update({ title: 'x' });

    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]).toMatchObject({ id: 's1', archived: false });
  });

  it('persists the authoritative document before recording to the mirror', async () => {
    const store = ix.get(IAtomicDocumentStore);
    // Read the persisted document back from inside record(): at that point
    // the mutation must already be durable.
    const persistedAtRecord: Promise<Record<string, unknown> | undefined>[] = [];
    const baseRecord = mirror.record;
    mirror.record = (summary) => {
      persistedAtRecord.push(store.get<Record<string, unknown>>(META_SCOPE, 'state.json'));
      baseRecord(summary);
    };

    const meta = ix.get(ISessionMetadata);
    await meta.ready; // first-time creation records too
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
    // The creation-time record throws inside load(); the load must survive.
    await meta.ready;
    await meta.update({ title: 'still fine' });
    expect(await meta.read()).toMatchObject({ title: 'still fine' });

    // The mutation reached the authoritative document: a fresh instance reads
    // it back even though every mirror record failed.
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
    // Agent registration is structural, not content activity — listings stay.
    expect(next.updatedAt).toBe(before);
  });

  it('records the fresh summary into the session index mirror on update', async () => {
    const meta = ix.get(ISessionMetadata);
    await meta.ready;
    // First-time creation is recorded (a new session must list immediately).
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
    // A resume loads silently; only mutations reach the mirror.
    expect(mirror.recorded).toEqual([]);

    await meta.setArchived(true);
    expect(mirror.recorded).toHaveLength(1);
    expect(mirror.recorded[0]?.archived).toBe(true);
  });
});
