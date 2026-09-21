import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HostFileSystem } from '#/os/backends/node-local/hostFsService';

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

describe('HostFileSystem unix mode', () => {
  it('creates a directory with the given mode and reads it back via stat', async () => {
    const target = join(dir, 'private');

    await fs.mkdir(target, { mode: 0o700 });

    const st = await fs.stat(target);
    expect(st.isDirectory).toBe(true);
    expect(st.mode).toBe(0o700);
  });

  it('reports the mode of files via stat and lstat', async () => {
    const target = join(dir, 'file.txt');
    await writeFile(target, 'x', 'utf-8');
    await chmod(target, 0o640);

    expect((await fs.stat(target)).mode).toBe(0o640);
    expect((await fs.lstat(target)).mode).toBe(0o640);
  });
});

describe('HostFileSystem rename', () => {
  it('renames a file within the same directory and preserves its contents', async () => {
    const from = join(dir, 'before.txt');
    const to = join(dir, 'after.txt');
    await writeFile(from, 'payload', 'utf-8');

    await fs.rename!(from, to);

    expect(await fs.readText(to)).toBe('payload');
    await expect(fs.stat(from)).rejects.toThrow();
  });

  it('moves a file across directories', async () => {
    const sub = join(dir, 'nested');
    await mkdir(sub);
    const from = join(dir, 'move.txt');
    const to = join(sub, 'move.txt');
    await writeFile(from, 'data', 'utf-8');

    await fs.rename!(from, to);

    expect(await fs.readText(to)).toBe('data');
  });

  it('rejects renaming a missing source', async () => {
    await expect(fs.rename!(join(dir, 'missing'), join(dir, 'target'))).rejects.toThrow();
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
