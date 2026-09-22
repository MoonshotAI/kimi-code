import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HostFsError } from '#/os/interface/hostFsErrors';
import { persistOriginalImage } from '#/agent/media/image-originals';
import type { ILogService } from '#/_base/log/log';
import { EnvironmentSkillDiscovery } from '#/features/skill/workspace/environmentSkillDiscovery';

import { RemoteExecConnection } from '#/remote/client/connection';
import { RemoteFileSystem } from '#/remote/client/remoteFileSystem';
import { FS_READ_DIRECTORY_MAX_ENTRIES, FS_READ_FILE_WHOLE_MAX_BYTES } from '#/remote/protocol/methods';
import {
  connectSubprocess,
  createInProcessLoopback,
  RawClient,
  type SpawnedExecutor,
} from './helpers/loopback';

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

  it('writes a byte stream progressively without retaining the complete input', async () => {
    const path = join(workDir, 'stream.bin');
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

  it('identifies symlinked files and directories in directory entries', async () => {
    const dir = join(workDir, 'symlink-entries');
    await fs.mkdir(join(dir, 'target-dir'), { recursive: true });
    await fs.writeText(join(dir, 'target.txt'), 'data');
    await symlink(join(dir, 'target-dir'), join(dir, 'linked-dir'));
    await symlink(join(dir, 'target.txt'), join(dir, 'linked.txt'));

    const entries = await fs.readdir(dir);
    expect(entries).toEqual(expect.arrayContaining([
      { name: 'linked-dir', isFile: false, isDirectory: false, isSymbolicLink: true },
      { name: 'linked.txt', isFile: false, isDirectory: false, isSymbolicLink: true },
      { name: 'target-dir', isFile: false, isDirectory: true, isSymbolicLink: false },
      { name: 'target.txt', isFile: true, isDirectory: false, isSymbolicLink: false },
    ]));
  });

  it('discovers skills exposed through symlinked remote directories', async () => {
    const root = join(workDir, 'skill-root');
    const target = join(workDir, 'shared-skill');
    await fs.mkdir(root);
    await fs.mkdir(target);
    await fs.writeText(join(target, 'SKILL.md'), '---\nname: shared-skill\ndescription: Example skill\n---\nUse this skill.');
    await symlink(target, join(root, 'shared-skill'));
    const warnings: string[] = [];
    const log: ILogService = {
      _serviceBrand: undefined,
      level: 'warn',
      setLevel: () => {},
      flush: async () => {},
      error: () => {},
      warn: (message) => { warnings.push(message); },
      info: () => {},
      debug: () => {},
      child: () => log,
    };
    const discovery = new EnvironmentSkillDiscovery(log, fs);

    const result = await discovery.discover([{ path: root, source: 'project' }]);

    expect(result.skills.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: 'shared-skill', path: join(root, 'shared-skill', 'SKILL.md') },
    ]);
    expect(warnings).toEqual([]);
  });

  it('manages directories: mkdir, readdir, rename, remove', async () => {
    const dir = join(workDir, 'a', 'b', 'c');
    await fs.mkdir(dir, { recursive: true });
    await expect(fs.mkdir(join(workDir, 'no-parent', 'child'))).rejects.toThrow(HostFsError);

    const file = join(dir, 'file.txt');
    await fs.writeText(file, 'x');
    const entries = await fs.readdir(dir);
    expect(entries).toEqual([{ name: 'file.txt', isFile: true, isDirectory: false, isSymbolicLink: false }]);

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

  it('persists original images larger than the frame cap without changing their contents', async () => {

    const size = 49 * 1024 * 1024;
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) data[i] = i % 251;
    const path = await persistOriginalImage(data, 'image/png', { dir: workDir, fs });
    expect(path).not.toBeNull();

    const read = await fs.readBytes(path!);
    expect(read.byteLength).toBe(size);
    expect(Buffer.from(read).equals(Buffer.from(data))).toBe(true);
  }, 60_000);

  it.each([false, true])('writes an empty stream when the destination exists: %s', async (exists) => {
    const path = join(workDir, `empty-${exists}.bin`);
    if (exists) await fs.writeText(path, 'old content');
    async function* input(): AsyncGenerator<Uint8Array> {
      yield* [];
    }
    await fs.writeBytes(path, input());

    expect((await fs.stat(path)).size).toBe(0);
    await expect(fs.readBytes(path)).resolves.toEqual(new Uint8Array(0));
  });

  it('creates exclusively with a payload larger than a chunk', async () => {
    const path = join(workDir, 'chunked-exclusive.bin');
    const data = new Uint8Array(2 * 1024 * 1024 + 3).map((_, index) => index % 249);
    await expect(fs.createExclusive(path, data)).resolves.toBe(true);
    await expect(fs.createExclusive(path, new Uint8Array([1]))).resolves.toBe(false);
    await expect(fs.readBytes(path)).resolves.toEqual(data);
  }, 30_000);
});

describe('fs protocol semantics', () => {
  it('reports capped directory listings on the wire and rejects them through the filesystem interface', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-exec-readdir-cap-'));
    const smallDir = await mkdtemp(join(tmpdir(), 'remote-exec-readdir-small-'));
    try {
      const total = FS_READ_DIRECTORY_MAX_ENTRIES + 1;
      for (let start = 0; start < total; start += 1000) {
        await Promise.all(
          Array.from({ length: Math.min(1000, total - start) }, (_, index) =>
            writeFile(join(dir, `entry-${String(start + index).padStart(6, '0')}`), ''),
          ),
        );
      }
      await writeFile(join(smallDir, 'a'), '');
      const loopback = createInProcessLoopback();
      const raw = new RawClient(loopback);
      await raw.handshake();
      raw.send({ id: 1, method: 'fs/readDirectory', params: { path: dir } });
      const capped = (await raw.nextResponse(1, 30_000))['result'] as {
        entries: unknown[];
        truncated: boolean;
      };
      expect(capped.entries.length).toBe(FS_READ_DIRECTORY_MAX_ENTRIES);
      expect(capped.truncated).toBe(true);

      raw.send({ id: 2, method: 'fs/readDirectory', params: { path: smallDir } });
      const complete = (await raw.nextResponse(2, 30_000))['result'] as {
        entries: unknown[];
        truncated: boolean;
      };
      expect(complete.entries.length).toBe(1);
      expect(complete.truncated).toBe(false);
      loopback.clientInput.end();
      await loopback.host.done;

      const adapterLoopback = createInProcessLoopback();
      const connection = await RemoteExecConnection.connect(adapterLoopback.clientPipe, {
        clientName: 'remote-exec-test',
        clientVersion: '0.0.0',
      });
      try {
        const fs = new RemoteFileSystem(connection);
        const listing = fs.readdir(dir);
        await expect(listing).rejects.toBeInstanceOf(HostFsError);
        await expect(listing).rejects.toMatchObject({
          code: 'os.fs.directory_too_large',
          details: { path: dir, op: 'readdir', limit: FS_READ_DIRECTORY_MAX_ENTRIES },
        });
        await expect(listing).rejects.toThrow(dir);
        await expect(listing).rejects.toThrow(String(FS_READ_DIRECTORY_MAX_ENTRIES));
        await expect(fs.readdir(smallDir)).resolves.toEqual([
          { name: 'a', isFile: true, isDirectory: false, isSymbolicLink: false },
        ]);
      } finally {
        connection.close();
        await adapterLoopback.host.done;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(smallDir, { recursive: true, force: true });
    }
  }, 60_000);
});
