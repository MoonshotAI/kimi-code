import { describe, expect, it } from 'vitest';

import { persistOriginalImage } from '#/agent/media/image-originals';

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
