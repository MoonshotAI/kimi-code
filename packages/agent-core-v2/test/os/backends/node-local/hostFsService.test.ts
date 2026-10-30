import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { walkHostDirectory } from '#/os/interface/hostFsWalk';

let dir: string;
let fs: HostFileSystem;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kimi-hostfs-'));
  fs = new HostFileSystem();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('HostFileSystem streamed writes', () => {
  it('writes a byte stream progressively without retaining the complete input', async () => {
    const path = join(dir, 'stream.bin');
    await fs.writeText(path, 'old content');
    const chunkSize = 2 * 1024 * 1024 + 3;
    async function* input(): AsyncGenerator<Uint8Array> {
      for (let index = 1; index <= 3; index += 1) {
        yield new Uint8Array(chunkSize).fill(index);
        expect((await fs.stat(path)).size).toBeGreaterThanOrEqual((index - 1) * chunkSize);
      }
    }
    await fs.writeBytes(path, input());

    const data = await fs.readBytes(path);
    expect(data.byteLength).toBe(3 * chunkSize);
    expect(Buffer.from(data).equals(Buffer.concat([
      Buffer.alloc(chunkSize, 1),
      Buffer.alloc(chunkSize, 2),
      Buffer.alloc(chunkSize, 3),
    ]))).toBe(true);
  });

  it.each([false, true])('writes an empty stream when the destination exists: %s', async (exists) => {
    const path = join(dir, 'empty.bin');
    if (exists) await fs.writeText(path, 'old content');
    async function* input(): AsyncGenerator<Uint8Array> {
      yield* [];
    }
    await fs.writeBytes(path, input());

    expect((await fs.stat(path)).size).toBe(0);
    await expect(fs.readBytes(path)).resolves.toEqual(new Uint8Array(0));
  });
});

describe('HostFileSystem walk', () => {
  const options = {
    maxDepth: 64,
    maxDirectories: 10_000,
    maxEntries: 100_000,
    maxResponseBytes: 8 * 1024 * 1024,
  };

  it('lists nested entries without following directory symlinks', async () => {
    await mkdir(join(dir, 'a/b'), { recursive: true });
    await writeFile(join(dir, 'a/b/file.ts'), '');
    await writeFile(join(dir, 'root.ts'), '');
    await symlink(join(dir, 'a'), join(dir, 'link'));

    const result = await fs.walk(dir, options);

    const names = result.entries.map((entry) => entry.name.slice(dir.length + 1));
    expect(names).toHaveLength(5);
    expect(names).toEqual(expect.arrayContaining([
      'a',
      'root.ts',
      'link',
      'a/b',
      'a/b/file.ts',
    ]));
    expect(result.entries.find((entry) => entry.name === join(dir, 'link'))?.isSymbolicLink).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('prunes ignored directories before traversing them', async () => {
    await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'node_modules/pkg/index.ts'), '');
    await writeFile(join(dir, 'src/app.ts'), '');

    const result = await fs.walk(dir, { ...options, ignore: ['node_modules/'] });

    expect(result.entries.map((entry) => entry.name.slice(dir.length + 1))).toEqual(['src', 'src/app.ts']);
    expect(result.truncated).toBe(false);
  });

  it('returns descendants at maxDepth but does not traverse below them', async () => {
    await mkdir(join(dir, 'a/b/c'), { recursive: true });
    await writeFile(join(dir, 'a/b/c/deep.ts'), '');

    const result = await fs.walk(dir, { ...options, maxDepth: 1 });

    expect(result.entries.map((entry) => entry.name.slice(dir.length + 1))).toEqual(['a', 'a/b']);
    expect(result.truncated).toBe(false);
  });

  it('reports missing roots as recoverable errors', async () => {
    const result = await fs.walk(join(dir, 'missing'), options);

    expect(result.entries).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      path: join(dir, 'missing'),
      error: { code: 'os.fs.not_found' },
    });
  });

  it('bounds directories and entries without reporting an exact fit as truncated', async () => {
    const tree = new Map<string, { name: string; isFile: boolean; isDirectory: boolean }[]>([
      ['/root', [
        { name: 'a', isFile: false, isDirectory: true },
        { name: 'b', isFile: false, isDirectory: true },
      ]],
      ['/root/a', [{ name: 'one.ts', isFile: true, isDirectory: false }]],
      ['/root/b', [{ name: 'two.ts', isFile: true, isDirectory: false }]],
    ]);
    const backend = {
      readdir: async (path: string) => tree.get(path) ?? [],
    };

    const exact = await walkHostDirectory(backend, '/root', {
      ...options,
      maxDirectories: 3,
      maxEntries: 4,
    });
    const boundedDirectories = await walkHostDirectory(backend, '/root', {
      ...options,
      maxDirectories: 2,
      maxEntries: 4,
    });
    const boundedEntries = await walkHostDirectory(backend, '/root', {
      ...options,
      maxDirectories: 3,
      maxEntries: 3,
    });

    expect(exact.truncated).toBe(false);
    expect(exact.entries).toHaveLength(4);
    expect(boundedDirectories.truncated).toBe(true);
    expect(boundedDirectories.entries.map((entry) => entry.name)).toEqual(['/root/a', '/root/b']);
    expect(boundedEntries.truncated).toBe(true);
    expect(boundedEntries.entries.map((entry) => entry.name)).toEqual(['/root/a', '/root/b', '/root/a/one.ts']);
  });

  it('counts entry and error JSON in the response budget', async () => {
    const backend = {
      readdir: async () => [{ name: 'a', isFile: true, isDirectory: false }],
    };
    const initial = await walkHostDirectory(backend, '/root', options);
    const tooSmall = await walkHostDirectory(backend, '/root', { ...options, maxResponseBytes: initial.responseBytes - 1 });

    expect(initial).toMatchObject({ truncated: false });
    expect(tooSmall).toMatchObject({ entries: [], truncated: true });

    const readWithError = async (maxResponseBytes: number) => walkHostDirectory(backend, '/root', {
      ...options,
      maxResponseBytes,
    }, {}, async (path) => {
      if (path === '/root') return [{ name: 'a', isFile: false, isDirectory: true }];
      throw new Error('unreadable');
    });
    const withError = await readWithError(options.maxResponseBytes);
    const beforeError = await readWithError(withError.responseBytes - 1);

    expect(withError.errors).toHaveLength(1);
    expect(beforeError).toMatchObject({ errors: [], truncated: true });
  });

  it('returns partial entries at the deadline', async () => {
    let clock = 1_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      const result = await walkHostDirectory({ readdir: async () => [] }, '/root', {
        ...options,
        deadlineMs: clock + 5,
      }, {}, async (path) => {
        if (path === '/root') return [{ name: 'a', isFile: false, isDirectory: true }];
        clock += 5;
        return [{ name: 'file.ts', isFile: true, isDirectory: false }];
      });

      expect(result.entries.map((entry) => entry.name)).toEqual(['/root/a']);
      expect(result.truncated).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('does not start walking at an expired deadline', async () => {
    let reads = 0;
    const result = await walkHostDirectory({
      readdir: async () => {
        reads += 1;
        return [];
      },
    }, '/root', { ...options, deadlineMs: Date.now() });

    expect(result).toMatchObject({ entries: [], truncated: true });
    expect(reads).toBe(0);
  });
});

describe('HostFileSystem stat / lstat', () => {
  it('stat follows a symlink to a regular file while lstat stats the link', async () => {
    const target = join(dir, 'target.txt');
    await writeFile(target, 'hello', 'utf-8');
    const link = join(dir, 'link.txt');
    await symlink(target, link);

    const st = await fs.stat(link);
    expect(st.isFile).toBe(true);
    expect(st.isSymbolicLink).not.toBe(true);

    const lst = await fs.lstat(link);
    expect(lst.isSymbolicLink).toBe(true);
    expect(lst.isFile).toBe(false);
  });

  it('stat follows a symlink to a directory', async () => {
    const target = join(dir, 'subdir');
    await mkdir(target);
    const link = join(dir, 'dirlink');
    await symlink(target, link);

    expect((await fs.stat(link)).isDirectory).toBe(true);
    expect((await fs.lstat(link)).isDirectory).toBe(false);
  });

  it('stat rejects a dangling symlink while lstat still stats the link', async () => {
    const link = join(dir, 'dangling');
    await symlink(join(dir, 'missing'), link);

    await expect(fs.stat(link)).rejects.toThrow();
    expect((await fs.lstat(link)).isSymbolicLink).toBe(true);
  });
});

describe('HostFileSystem streamed UTF-8 lines', () => {
  it('preserves Unicode across chunks, CRLF, and a BOM after the first line', async () => {
    const path = join(dir, 'unicode.txt');
    const first = 'a'.repeat(65_531) + '🙂é\r\n';
    const second = '\uFEFFsecond\n';
    await writeFile(path, '\uFEFF' + first + second + 'last');
    const lines: string[] = [];
    for await (const line of fs.readLines(path)) lines.push(line);
    expect(lines).toEqual([first, second, 'last']);
  });

  it('rejects malformed UTF-8 rather than replacing bytes in strict mode', async () => {
    const path = join(dir, 'invalid.txt');
    await writeFile(path, Buffer.from([0x61, 0x0a, 0xc3]));
    const read = async () => {
      for await (const _line of fs.readLines(path, { errors: 'strict' })) {}
    };
    await expect(read()).rejects.toThrow();
  });
});
