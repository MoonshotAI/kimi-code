import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileArtexArtifactStore } from './fileArtexArtifactStore';

describe('FileArtexArtifactStore', () => {
  let dir: string;
  let store: FileArtexArtifactStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'artex-artifact-'));
    store = new FileArtexArtifactStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips a body by content hash', async () => {
    const body = Buffer.from('GET /secret HTTP/1.1\r\nHost: example.test\r\n\r\n');
    const { hash, length } = await store.writeBody(body);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(length).toBe(body.length);

    const read = await store.readBody(hash, length);
    expect(read?.equals(body)).toBe(true);

    const range = await store.blobRange(hash, 4, 7);
    expect(range?.total).toBe(body.length);
    expect(range?.data.toString()).toBe('/secret');
  });

  it('dedups identical bodies to one blob', async () => {
    const body = Buffer.from('repeated-evidence-body');
    const first = await store.writeBody(body);
    const second = await store.writeBody(body);
    expect(second.hash).toBe(first.hash);
    expect(await store.exists(first.hash)).toBe(true);
  });

  it('rejects a body whose expected hash does not match its bytes', async () => {
    await expect(
      store.writeBody(Buffer.from('abc'), 'f'.repeat(64)),
    ).rejects.toThrow(/hash mismatch/);
  });

  it('keeps referenced and fresh blobs but reaps aged, unreferenced ones', async () => {
    const live = await store.writeBody(Buffer.from('still-referenced'));
    const stale = await store.writeBody(Buffer.from('orphaned-body'));

    const future = Date.now() + 2 * 24 * 60 * 60 * 1000;
    const removed = await store.collect(new Set([live.hash]), future);
    expect(removed).toBe(1);
    expect(await store.exists(live.hash)).toBe(true);
    expect(await store.exists(stale.hash)).toBe(false);
  });
});
