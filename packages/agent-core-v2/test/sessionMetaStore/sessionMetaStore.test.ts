import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/log';
import { ISessionMetaStore } from '#/sessionMetaStore';
import { SessionMetaStore } from '#/sessionMetaStore/sessionMetaStoreService';
import { ConfigStore, IConfigStore, IStorageService, InMemoryStorageService } from '#/storage';

import { stubLog } from '../log/stubs';

describe('SessionMetaStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(async () => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(ILogService, stubLog());
    ix.set(IStorageService, new SyncDescriptor(InMemoryStorageService));
    ix.set(IConfigStore, new SyncDescriptor(ConfigStore));
    ix.set(ISessionMetaStore, new SyncDescriptor(SessionMetaStore));
  });

  afterEach(async () => {
    disposables.dispose();
  });

  it('read returns {} when no document is stored yet', async () => {
    const meta = ix.get(ISessionMetaStore);
    expect(await meta.read()).toEqual({});
  });

  it('write merges and persists; read round-trips', async () => {
    const meta = ix.get(ISessionMetaStore);
    await meta.write({ title: 'hello' });
    await meta.write({ count: 1 });

    const fresh = ix.get(ISessionMetaStore);
    expect(await fresh.read()).toEqual({ title: 'hello', count: 1 });
  });
});
