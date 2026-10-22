import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { nodeBlobBackend } from '#/blob/backend/node';
import { BlobIntegrityError, openBlobStore } from '#/blob/index';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('node blob backend', () => {
  it('stores blobs by content with metadata and integrity checks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-core-blob-'));
    dirs.push(dir);
    const blobs = openBlobStore(nodeBlobBackend(dir));
    const content = { bytes: new TextEncoder().encode('# plan'), mimeType: 'text/markdown', filename: 'plan.md' };
    const first = await blobs.put(content);
    expect(await blobs.put(content)).toEqual(first);
    expect(first.size).toBe(content.bytes.byteLength);
    expect(await blobs.get(first.ref)).toEqual(content);
    await writeFile(join(dir, 'data', first.ref), 'tampered');
    await expect(blobs.get(first.ref)).rejects.toBeInstanceOf(BlobIntegrityError);
    expect(await blobs.get('0'.repeat(64))).toBeUndefined();
    expect(await blobs.get('../x')).toBeUndefined();

    expect(await blobs.list()).toEqual([first.ref]);
    await writeFile(join(dir, 'data', 'stray.tmp'), 'x');
    const prefixed = openBlobStore(nodeBlobBackend(dir), 'file-history');
    expect(await prefixed.put(content)).toEqual(first);
    expect(await prefixed.list()).toEqual([first.ref]);
    expect(await prefixed.has(first.ref)).toBe(true);
    await blobs.delete(first.ref);
    expect(await blobs.has(first.ref)).toBe(false);
    expect(await blobs.list()).toEqual([]);
    expect(await prefixed.has(first.ref)).toBe(true);
    expect(() => openBlobStore(nodeBlobBackend(dir), 'bad prefix')).toThrow(TypeError);
  });
});
