import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LocalKaos } from '@moonshot-ai/kaos';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ISessionKaosService } from '#/kaos';
import { SessionKaosService } from '#/kaos/sessionKaosService';
import { ILogService } from '#/log';
import { stubLog } from '../log/stubs';
import { ISessionMetaStore } from '#/sessionMetaStore';
import { SessionMetaStore } from '#/sessionMetaStore/sessionMetaStoreService';

describe('SessionMetaStore', () => {
  let dir: string;
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'session-meta-test-'));
    const base = await LocalKaos.create();
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.set(ISessionKaosService, new SyncDescriptor(SessionKaosService));
    ix.set(ISessionMetaStore, new SyncDescriptor(SessionMetaStore));
    const sessionKaos = ix.get(ISessionKaosService);
    sessionKaos.setPersistenceKaos(base.withCwd(dir));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(dir, { recursive: true, force: true });
  });

  it('read returns {} when state.json is absent', async () => {
    const meta = ix.get(ISessionMetaStore);
    expect(await meta.read()).toEqual({});
  });

  it('write merges and persists; read round-trips', async () => {
    const meta = ix.get(ISessionMetaStore);
    await meta.write({ title: 'hello' });
    await meta.write({ count: 1 });

    // read() goes straight to disk, so even the same instance reflects the
    // persisted state (no in-memory cache to mask a failed flush).
    const fresh = ix.get(ISessionMetaStore);
    expect(await fresh.read()).toEqual({ title: 'hello', count: 1 });
  });
});
