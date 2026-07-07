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

import { stubFlag } from '../flag/stubs';
import { stubLog } from '../log/stubs';
import { stubQueryStore } from '../persistence/stubs';

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
    expect(await meta.read()).toMatchObject({ id: 's1', archived: false });
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
        homedir: '/tmp/sessions/wd_test/s1/agents/agent-0',
        labels: { swarmItem: 'src/a.ts' },
      }),
      meta.registerAgent('agent-1', {
        homedir: '/tmp/sessions/wd_test/s1/agents/agent-1',
        labels: { swarmItem: 'src/b.ts' },
      }),
    ]);

    expect(Object.keys((await meta.read()).agents ?? {}).sort()).toEqual([
      'agent-0',
      'agent-1',
    ]);
  });
});
