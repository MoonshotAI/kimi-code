import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostFileSystem, walkDirectoryTree } from '#/os/backends/node-local/hostFsService';
import type { HostDirEntry, HostWalkEntry, HostWalkVisitor } from '#/os/interface/hostFileSystem';

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
  async function collect(
    walk: (visit: HostWalkVisitor) => Promise<{ readonly truncated: boolean }>,
    stopAfter = Infinity,
  ) {
    const entries: HostWalkEntry[] = [];
    const { truncated } = await walk((entry) => {
      if (entries.length >= stopAfter) return false;
      entries.push(entry);
    });
    return { entries, truncated };
  }

  it('visits nested entries depth-first without following directory symlinks', async () => {
    await mkdir(join(dir, 'a/b'), { recursive: true });
    await writeFile(join(dir, 'a/b/file.ts'), '');
    await symlink(join(dir, 'a'), join(dir, 'link'));

    const { entries, truncated } = await collect((visit) => fs.walk(dir, {}, visit));

    expect(entries.toSorted((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: 'a', kind: 'directory' },
      { path: 'a/b', kind: 'directory' },
      { path: 'a/b/file.ts', kind: 'file' },
      { path: 'link', kind: 'symlink' },
    ]);
    const paths = entries.map((entry) => entry.path);
    expect(paths.indexOf('a/b/file.ts')).toBe(paths.indexOf('a/b') + 1);
    expect(truncated).toBe(false);
  });

  it('prunes ignored directories before reading them', async () => {
    const tree = new Map<string, HostDirEntry[]>([
      ['/root', [
        { name: 'node_modules', isFile: false, isDirectory: true },
        { name: 'src', isFile: false, isDirectory: true },
      ]],
      ['/root/src', [{ name: 'app.ts', isFile: true, isDirectory: false }]],
    ]);
    const readdir = vi.fn(async (path: string) => tree.get(path) ?? []);

    const { entries } = await collect((visit) => walkDirectoryTree({ readdir }, '/root', { ignore: ['node_modules/'] }, visit));

    expect(entries.map((entry) => entry.path)).toEqual(['src', 'src/app.ts']);
    expect(readdir.mock.calls.map(([path]) => path)).toEqual(['/root', '/root/src']);
  });

  it('skips unreadable directories', async () => {
    const { entries, truncated } = await collect((visit) => fs.walk(join(dir, 'missing'), {}, visit));

    expect(entries).toEqual([]);
    expect(truncated).toBe(false);
  });

  it('keeps dot-only filenames while pruning ignored directories', async () => {
    const readdir = vi.fn(async (): Promise<HostDirEntry[]> => [
      { name: '...', isFile: true, isDirectory: false },
      { name: '.git', isFile: false, isDirectory: true },
      { name: 'kept.ts', isFile: true, isDirectory: false },
    ]);
    const { entries, truncated } = await collect((visit) => walkDirectoryTree({ readdir }, '/root', { ignore: ['.git'] }, visit));

    expect(entries.map((entry) => entry.path)).toEqual(['...', 'kept.ts']);
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(truncated).toBe(false);
  });

  it('reports truncation when the visitor stops or the deadline passes', async () => {
    const readdir = async (path: string): Promise<HostDirEntry[]> => path === '/root'
      ? [{ name: 'a', isFile: false, isDirectory: true }, { name: 'b.ts', isFile: true, isDirectory: false }]
      : [{ name: 'c.ts', isFile: true, isDirectory: false }];

    const stopped = await collect((visit) => walkDirectoryTree({ readdir }, '/root', {}, visit), 1);
    const expired = await collect((visit) => walkDirectoryTree({ readdir }, '/root', { deadlineMs: Date.now() }, visit));

    expect(stopped).toEqual({ entries: [{ path: 'a', kind: 'directory' }], truncated: true });
    expect(expired).toEqual({ entries: [], truncated: true });
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
