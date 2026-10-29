import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HostFsError } from '#/os/interface/hostFsErrors';

import { RemoteExecConnection } from '#/remote/client/connection';
import { RemoteFileSystem } from '#/os/backends/remote/remoteFileSystem';
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

  it('round-trips binary data written across chunk boundaries', async () => {
    const path = join(workDir, 'binary.bin');
    const data = new Uint8Array(2 * 1024 * 1024 + 7);
    for (let i = 0; i < data.byteLength; i += 1) data[i] = (i * 131 + 7) % 256;
    await fs.writeBytes(path, data);
    await fs.appendText(path, '中'.repeat(400 * 1024));

    const read = await fs.readBytes(path);
    expect(Buffer.from(read).equals(Buffer.concat([Buffer.from(data), Buffer.from('中'.repeat(400 * 1024))]))).toBe(true);
  }, 30_000);

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
