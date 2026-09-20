import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HostFsError } from '@moonshot-ai/agent-core-v2/os/interface/hostFsErrors';

import type { RemoteExecConnection } from '../src/client/connection';
import { RemoteFileSystem } from '../src/client/remoteFileSystem';
import { FS_READ_FILE_WHOLE_MAX_BYTES } from '../src/protocol/methods';
import { connectSubprocess, type SpawnedExecutor } from './helpers/loopback';

describe('fs group over a subprocess loopback', () => {
  let connection: RemoteExecConnection;
  let spawned: SpawnedExecutor;
  let fs: RemoteFileSystem;
  let workDir: string;

  beforeAll(async () => {
    ({ connection, spawned } = await connectSubprocess());
    fs = new RemoteFileSystem(connection);
    workDir = await mkdtemp(join(tmpdir(), 'remote-exec-fs-'));
  }, 60_000);

  afterAll(async () => {
    connection.close();
    spawned.bridge.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('writes and reads text round-trip', async () => {
    const path = join(workDir, 'hello.txt');
    await fs.writeText(path, 'hello 世界\n');
    await expect(fs.readText(path)).resolves.toBe('hello 世界\n');
    const stat = await fs.stat(path);
    expect(stat.isFile).toBe(true);
    expect(stat.isDirectory).toBe(false);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('appends text', async () => {
    const path = join(workDir, 'append.txt');
    await fs.writeText(path, 'a');
    await fs.appendText(path, 'b');
    await fs.appendText(path, 'c');
    await expect(fs.readText(path)).resolves.toBe('abc');
  });

  it('appends bytes', async () => {
    const path = join(workDir, 'append.bin');
    await fs.writeBytes(path, new Uint8Array([1, 2]));
    await fs.appendBytes(path, new Uint8Array([3, 4]));
    await fs.appendBytes(path, new Uint8Array([5]));
    await expect(fs.readBytes(path)).resolves.toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it('reads byte ranges', async () => {
    const path = join(workDir, 'range.bin');
    const data = new Uint8Array(256).map((_, index) => index);
    await fs.writeBytes(path, data);
    await expect(fs.readBytes(path)).resolves.toEqual(data);
    await expect(fs.readBytes(path, 4, 10)).resolves.toEqual(data.subarray(10, 14));
    await expect(fs.readBytes(path, undefined, 250)).resolves.toEqual(data.subarray(250));
    await expect(fs.readBytes(path, 4, 1000)).resolves.toEqual(new Uint8Array(0));
  });

  it('reads files larger than the whole-file limit in bounded chunks', async () => {
    const path = join(workDir, 'big.bin');
    const size = FS_READ_FILE_WHOLE_MAX_BYTES + 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) data[i] = i % 251;
    await writeFile(path, data);

    const read = await fs.readBytes(path);
    expect(read.byteLength).toBe(size);
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
  }, 30_000);

  it('reads text larger than the whole-file limit in bounded chunks', async () => {
    const path = join(workDir, 'big.txt');
    const unit = `remote-exec-read-text-${'x'.repeat(55)}\n`;
    const content = unit.repeat(Math.ceil((FS_READ_FILE_WHOLE_MAX_BYTES + 1024 * 1024) / unit.length));
    await writeFile(path, content);

    await expect(fs.readText(path)).resolves.toBe(content);
  }, 30_000);

  it('creates exclusively and reports false for an existing path', async () => {
    const path = join(workDir, 'exclusive.txt');
    await expect(fs.createExclusive(path, new Uint8Array([1, 2, 3]))).resolves.toBe(true);
    await expect(fs.createExclusive(path, new Uint8Array([4]))).resolves.toBe(false);
    await expect(fs.readBytes(path)).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('reads lines including a multi-chunk file', async () => {
    const path = join(workDir, 'lines.txt');
    const lines: string[] = [];
    for (let i = 0; i < 30_000; i += 1) {
      lines.push(`line-${i}-${'x'.repeat(i % 50)}`);
    }
    const content = `${lines.join('\n')}\n`;
    await fs.writeText(path, content);
    expect(content.length).toBeGreaterThan(1024 * 1024);
    const collected: string[] = [];
    for await (const line of fs.readLines(path)) {
      collected.push(line);
    }
    expect(collected).toEqual(lines.map((line) => `${line}\n`));
  });

  it('distinguishes stat from lstat on a symlink', async () => {
    const target = join(workDir, 'target.txt');
    const link = join(workDir, 'link.txt');
    await fs.writeText(target, 'data');
    await symlink(target, link);
    const followed = await fs.stat(link);
    expect(followed.isFile).toBe(true);
    const linkStat = await fs.lstat(link);
    expect(linkStat.isSymbolicLink).toBe(true);
    expect(linkStat.isFile).toBe(false);
    await expect(fs.realpath(link)).resolves.toBe(await fs.realpath(target));
  });

  it('manages directories: mkdir, readdir, rename, remove', async () => {
    const dir = join(workDir, 'a', 'b', 'c');
    await fs.mkdir(dir, { recursive: true });
    await expect(fs.mkdir(join(workDir, 'no-parent', 'child'))).rejects.toThrow(HostFsError);

    const file = join(dir, 'file.txt');
    await fs.writeText(file, 'x');
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([{ name: 'file.txt', isFile: true, isDirectory: false }]);

    const renamed = join(dir, 'renamed.txt');
    await fs.rename(file, renamed);
    await expect(fs.readText(renamed)).resolves.toBe('x');
    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'os.fs.not_found' });

    await fs.remove(join(workDir, 'a'));
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'os.fs.not_found' });
  });

  it('creates a directory with a unix mode and reads it back', async () => {
    const dir = join(workDir, 'private');
    await fs.mkdir(dir, { mode: 0o700 });

    const st = await fs.stat(dir);
    expect(st.isDirectory).toBe(true);
    expect(st.mode).toBe(0o700);
  });

  it('reads back the unix mode of an existing file', async () => {
    const file = join(workDir, 'mode.txt');
    await fs.writeText(file, 'x');
    await chmod(file, 0o640);

    expect((await fs.stat(file)).mode).toBe(0o640);
    expect((await fs.lstat(file)).mode).toBe(0o640);
  });

  it('maps io failures to fs domain errors', async () => {
    await expect(fs.readText(join(workDir, 'missing.txt'))).rejects.toMatchObject({
      name: 'HostFsError',
      code: 'os.fs.not_found',
    });
    const file = join(workDir, 'not-a-dir.txt');
    await fs.writeText(file, 'x');
    await expect(fs.readdir(file)).rejects.toMatchObject({ code: 'os.fs.not_directory' });
    await expect(fs.readText(workDir)).rejects.toMatchObject({ code: 'os.fs.is_directory' });
  });
});
