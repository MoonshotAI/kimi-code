import { describe, expect, it } from 'vitest';

import { FileStore } from '#/filestore/fileStoreService';

describe('FileStore', () => {
  it('put / get / delete', async () => {
    const store = new FileStore(undefined as never);
    const data = new TextEncoder().encode('hello');
    await store.put('k1', data);
    expect(await store.get('k1')).toEqual(data);
    await store.delete('k1');
    expect(await store.get('k1')).toBeUndefined();
  });
});
