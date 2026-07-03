/**
 * image-originals — content-addressed cache for pre-compression originals.
 *
 * Tests pin:
 *   - a persisted original lands under the cache dir, named by content hash
 *     with a mime-derived extension, bytes intact
 *   - persistence is idempotent: same bytes → same path, no duplicate file
 *   - different bytes → different paths
 *   - the cache is size-capped: oldest files are evicted once the cap is
 *     exceeded, newest survive
 *   - best effort: an unwritable destination yields null, never a throw
 */

import { mkdtemp, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line import/no-unresolved
import {
  originalImageCacheDir,
  persistOriginalImage,
  sessionMediaOriginalsDir,
} from '../../src/tools/support/image-originals';

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'image-originals-test-'));
}

describe('persistOriginalImage', () => {
  it('writes the bytes under a hash-named file with a mime extension', async () => {
    const dir = await freshDir();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);

    const path = await persistOriginalImage(bytes, 'image/png', { dir });

    expect(path).not.toBeNull();
    expect(path!.startsWith(dir)).toBe(true);
    expect(path!).toMatch(/\.png$/);
    expect(new Uint8Array(await readFile(path!))).toEqual(bytes);
  });

  it('maps jpeg mime types to a .jpg extension', async () => {
    const dir = await freshDir();
    const path = await persistOriginalImage(new Uint8Array([9, 9]), 'image/jpeg', { dir });
    expect(path!).toMatch(/\.jpg$/);
  });

  it('is idempotent for identical bytes', async () => {
    const dir = await freshDir();
    const bytes = new Uint8Array([7, 7, 7]);

    const first = await persistOriginalImage(bytes, 'image/png', { dir });
    const second = await persistOriginalImage(bytes, 'image/png', { dir });

    expect(second).toBe(first);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it('gives distinct paths to distinct bytes', async () => {
    const dir = await freshDir();
    const a = await persistOriginalImage(new Uint8Array([1]), 'image/png', { dir });
    const b = await persistOriginalImage(new Uint8Array([2]), 'image/png', { dir });
    expect(a).not.toBe(b);
    expect(await readdir(dir)).toHaveLength(2);
  });

  it('evicts the oldest files once the cache exceeds its cap', async () => {
    const dir = await freshDir();
    const old = await persistOriginalImage(new Uint8Array(64).fill(1), 'image/png', {
      dir,
      maxTotalBytes: 1024,
    });
    // Backdate the first file so eviction order is deterministic.
    const past = new Date(Date.now() - 60_000);
    await utimes(old!, past, past);

    const fresh = await persistOriginalImage(new Uint8Array(1000).fill(2), 'image/png', {
      dir,
      maxTotalBytes: 1024,
    });

    // old (64B) + fresh (1000B) > 1024B cap → the backdated file is evicted.
    await expect(stat(old!)).rejects.toThrow();
    await expect(stat(fresh!)).resolves.toBeDefined();
  });

  it('returns null instead of throwing when the destination is unusable', async () => {
    const dir = await freshDir();
    const blocker = join(dir, 'not-a-dir');
    await writeFile(blocker, 'plain file');

    const path = await persistOriginalImage(new Uint8Array([1]), 'image/png', { dir: blocker });

    expect(path).toBeNull();
  });
});

describe('originalImageCacheDir', () => {
  it('defaults to a kimi-code cache directory under the OS temp dir', () => {
    const dir = originalImageCacheDir();
    expect(dir.startsWith(tmpdir())).toBe(true);
    expect(dir).toContain('kimi-code');
  });
});

describe('sessionMediaOriginalsDir', () => {
  it('nests the originals dir inside the session dir', () => {
    expect(sessionMediaOriginalsDir('/home/u/.kimi-code/sessions/ws/abc')).toBe(
      '/home/u/.kimi-code/sessions/ws/abc/media-originals',
    );
  });
});
