import { describe, expect, it, vi } from 'vitest';

import { persistOriginalImage } from '#/agent/media/image-originals';

vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, join: actual.win32.join };
});

interface FakeFile {
  readonly data: Uint8Array;
  readonly mtimeMs: number;
}

const posixPath = { join: (...parts: readonly string[]) => parts.join('/') };

function expectStoredBytes(files: ReadonlyMap<string, FakeFile>, path: string, expected: Uint8Array): void {
  const written = files.get(path);
  if (written === undefined) throw new Error(`nothing written to ${path}`);
  expect(written.data.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(written.data), Buffer.from(expected))).toBe(0);
}

describe('persistOriginalImage', () => {
  it('preserves the bytes of a large original', async () => {
    const bytes = new Uint8Array(49 * 1024 * 1024).fill(0xab);
    const files = new Map<string, FakeFile>();
    const persisted = await persistOriginalImage(bytes, 'image/png', {
      dir: '/remote/tmp/kimi-code/original-images',
      fs: createFakeFs(files),
      path: posixPath,
    });

    expect(persisted).not.toBeNull();
    expectStoredBytes(files, persisted!, bytes);
  });
});

function createFakeFs(files: Map<string, FakeFile>) {
  return {
    mkdir: async () => {},
    writeBytes: async (path: string, data: Uint8Array | AsyncIterable<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      if (data instanceof Uint8Array) chunks.push(data);
      else for await (const chunk of data) chunks.push(chunk);
      files.set(path, { data: Buffer.concat(chunks), mtimeMs: 1_000 });
    },
    stat: async (path: string) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`ENOENT: ${path}`);
      return { isFile: true, isDirectory: false, size: file.data.length, mtimeMs: file.mtimeMs };
    },
    readdir: async (dir: string) =>
      [...files.keys()]
        .filter((key) => key.startsWith(`${dir}/`))
        .map((key) => ({ name: key.slice(dir.length + 1), isFile: true, isDirectory: false })),
    remove: async (path: string) => {
      files.delete(path);
    },
  };
}

describe('persistOriginalImage on a win32 host', () => {
  it('joins the originals path with the target path class', async () => {
    const files = new Map<string, FakeFile>();
    const dir = '/tmp/kimi-code/original-images';

    const persisted = await persistOriginalImage(new Uint8Array([1, 2, 3]), 'image/png', {
      dir,
      fs: createFakeFs(files),
      path: posixPath,
    });

    expect(persisted).toMatch(/^\/tmp\/kimi-code\/original-images\/[a-f0-9]{32}\.png$/);
    expect(persisted).not.toContain('\\');
    expect([...files.keys()]).toEqual([persisted]);
  });

  it('sweeps cache entries with the target path class', async () => {
    const dir = '/tmp/kimi-code/original-images';
    const files = new Map<string, FakeFile>([
      [`${dir}/old-one.png`, { data: new Uint8Array(10), mtimeMs: 1 }],
      [`${dir}/old-two.png`, { data: new Uint8Array(10), mtimeMs: 2 }],
    ]);
    const fs = createFakeFs(files);
    const removed: string[] = [];
    const trackingFs = {
      ...fs,
      remove: async (path: string) => {
        removed.push(path);
        await fs.remove(path);
      },
    };

    const persisted = await persistOriginalImage(new Uint8Array(3), 'image/png', {
      dir,
      fs: trackingFs,
      path: posixPath,
      maxTotalBytes: 12,
    });

    expect(persisted).not.toBeNull();
    expect(removed).toHaveLength(2);
    for (const path of removed) {
      expect(path).toMatch(/^\/tmp\/kimi-code\/original-images\/[^/\\]+\.png$/);
    }
    expect([...files.keys()]).toEqual([persisted]);
  });

  it('keeps host path class semantics when no target path class is given', async () => {
    const files = new Map<string, FakeFile>();

    const persisted = await persistOriginalImage(new Uint8Array([1]), 'image/png', {
      dir: 'C:\\Temp\\original-images',
      fs: createFakeFs(files),
    });

    expect(persisted).toMatch(/^C:\\Temp\\original-images\\[a-f0-9]{32}\.png$/);
    expect([...files.keys()]).toEqual([persisted]);
  });
});
