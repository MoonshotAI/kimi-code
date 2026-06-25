import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import type { TestInstantiationService } from '#/_base/di/test';
import { IFileStore } from '#/filestore/filestore';
import { FileStore } from '#/filestore/fileStoreService';
import { IKaosFactory } from '#/kaos/kaos';

describe('FileStore', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IKaosFactory, {});
        reg.define(IFileStore, FileStore);
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('put / get / delete', async () => {
    const store = ix.get(IFileStore);
    const data = new TextEncoder().encode('hello');
    await store.put('k1', data);
    expect(await store.get('k1')).toEqual(data);
    await store.delete('k1');
    expect(await store.get('k1')).toBeUndefined();
  });
});
