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

const FRAME_CAP_BYTES = 64 * 1024 * 1024;
const CHUNK_BYTES = 16 * 1024 * 1024;

interface WriteCall {
  readonly path: string;
  readonly mode: 'truncate' | 'append';
  readonly data: Uint8Array;
}

function patternedBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) data[index] = index % 251;
  return data;
}

function createChunkedFakeFs(files: Map<string, FakeFile>, options: { append: boolean }) {
  const writes: WriteCall[] = [];
  const put = (path: string, data: Uint8Array, mode: 'truncate' | 'append'): void => {
    if (Math.ceil(data.byteLength / 3) * 4 > FRAME_CAP_BYTES) {
      throw new Error('message exceeds the frame cap');
    }
    writes.push({ path, mode, data });
    const existing = files.get(path);
    files.set(path, {
      data: mode === 'append' && existing !== undefined
        ? Buffer.concat([existing.data, data])
        : data,
      mtimeMs: 1_000,
    });
  };
  const fs = {
    ...createFakeFs(files),
    writeBytes: async (path: string, data: Uint8Array) => {
      put(path, data, 'truncate');
    },
    appendBytes: options.append
      ? async (path: string, data: Uint8Array) => {
        put(path, data, 'append');
      }
      : undefined,
  };
  return { fs, writes };
}

function expectStoredBytes(files: ReadonlyMap<string, FakeFile>, path: string, expected: Uint8Array): void {
  const written = files.get(path);
  if (written === undefined) throw new Error(`nothing written to ${path}`);
  expect(written.data.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(written.data), Buffer.from(expected))).toBe(0);
}

describe('persistOriginalImage chunking', () => {
  it('persists an original whose base64 form exceeds the frame cap in truncate-then-append chunks', async () => {
    const dir = '/remote/tmp/kimi-code/original-images';
    const size = 48 * 1024 * 1024 + 1;
    expect(Math.ceil(size / 3) * 4).toBeGreaterThan(FRAME_CAP_BYTES);
    const bytes = patternedBytes(size);
    const files = new Map<string, FakeFile>();
    const { fs, writes } = createChunkedFakeFs(files, { append: true });

    const persisted = await persistOriginalImage(bytes, 'image/png', {
      dir,
      fs,
      path: posixPath,
    });

    expect(persisted).not.toBeNull();
    expectStoredBytes(files, persisted!, bytes);
    expect(writes.length).toBe(Math.ceil(size / CHUNK_BYTES));
    expect(writes.length).toBeGreaterThan(1);
    expect(writes[0]!.mode).toBe('truncate');
    expect(writes.slice(1).every((write) => write.mode === 'append')).toBe(true);
    for (const write of writes) {
      expect(write.data.byteLength).toBeLessThanOrEqual(CHUNK_BYTES);
    }
  });

  it('writes a small original with a single truncate write on an append-capable fs', async () => {
    const dir = '/remote/tmp/kimi-code/original-images';
    const bytes = patternedBytes(1024);
    const files = new Map<string, FakeFile>();
    const { fs, writes } = createChunkedFakeFs(files, { append: true });

    const persisted = await persistOriginalImage(bytes, 'image/png', {
      dir,
      fs,
      path: posixPath,
    });

    expect(persisted).not.toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.mode).toBe('truncate');
    expectStoredBytes(files, persisted!, bytes);
  });

  it('falls back to a single write when the fs lacks appendBytes', async () => {
    const dir = '/tmp/kimi-code/original-images';
    const bytes = patternedBytes(CHUNK_BYTES + 1);
    const files = new Map<string, FakeFile>();
    const { fs, writes } = createChunkedFakeFs(files, { append: false });

    const persisted = await persistOriginalImage(bytes, 'image/png', {
      dir,
      fs,
      path: posixPath,
    });

    expect(persisted).not.toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.mode).toBe('truncate');
    expectStoredBytes(files, persisted!, bytes);
  });
});

function createFakeFs(files: Map<string, FakeFile>) {
  return {
    mkdir: async () => {},
    writeBytes: async (path: string, data: Uint8Array) => {
      files.set(path, { data, mtimeMs: 1_000 });
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
