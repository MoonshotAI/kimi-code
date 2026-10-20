import { describe, expect, it } from 'vitest';

import { durableObjectBlobBackend } from '#/blob/backend/durable-object';
import { openBlobStore } from '#/blob/index';

import { sqliteStorage } from '../../utils/durable-object';

describe('durable object blob backend', () => {
  it('stores blobs in parts', async () => {
    const blobs = openBlobStore(durableObjectBlobBackend(sqliteStorage()));
    const bytes = new Uint8Array(2_100_000).map((_, index) => index % 251);
    const { ref } = await blobs.put({ bytes });
    expect((await blobs.get(ref))?.bytes).toEqual(bytes);
    const empty = await blobs.put({ bytes: new Uint8Array() });
    expect(await blobs.has(empty.ref)).toBe(true);
    expect((await blobs.get(empty.ref))?.bytes.byteLength).toBe(0);
    expect(await blobs.get('f'.repeat(64))).toBeUndefined();
  });
});
