import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { FileEditService } from '#/app/edit/fileEditService';
import { HostFsError } from '#/os/interface/hostFsErrors';

import { RemoteExecConnection } from '#/remote/client/connection';
import { requireAbsolutePath } from '#/remote/server/fsHandler';
import { RemoteFileSystem } from '#/os/backends/remote/remoteFileSystem';
import {
  FS_READ_DIRECTORY_MAX_ENTRIES,
  FS_READ_DIRECTORY_METHOD,
  FS_READ_FILE_WHOLE_MAX_BYTES,
  FS_WALK_METHOD,
} from '#/remote/protocol/methods';
import {
  connectInProcess,
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads metadata and the file head in one RPC', async () => {
    const path = join(workDir, 'head.txt');
    await writeFile(path, 'alpha\nbeta\n');
    const calls = vi.spyOn(connection, 'call');
    const head = await fs.readFileHead(path, 5);
    expect(Buffer.from(head.bytes).toString('utf8')).toBe('alpha');
    expect(head.stat).toMatchObject({ isFile: true, isDirectory: false, size: 11 });
    expect(head.stat.mtimeMs).toBeGreaterThan(0);
    expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/readFile']);
  });

  it('returns metadata without bytes for directories and devices', async () => {
    for (const target of [workDir, '/dev/null']) {
      const head = await fs.readFileHead(target, 5);
      expect(head.stat.isFile).toBe(false);
      expect(head.bytes.byteLength).toBe(0);
    }
  });

  it('edits a small file with one read and one write RPC', async () => {
    const path = join(workDir, 'edit.txt');
    await writeFile(path, 'before\nold value\n');
    const editor = new FileEditService(fs);
    const calls = vi.spyOn(connection, 'call');
    const result = await editor.edit({
      path,
      displayPath: 'edit.txt',
      old_string: 'old value',
      new_string: 'new value',
      replace_all: false,
    });
    expect(result).toEqual({ ok: true, count: 1 });
    expect(calls.mock.calls.map(([method]) => method)).toEqual(['fs/readFile', 'fs/writeFile']);
    expect(await readFile(path, 'utf8')).toBe('before\nnew value\n');
  });

  it('preserves a UTF-8 BOM when editing', async () => {
    const path = join(workDir, 'edit-bom.txt');
    await writeFile(path, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0x62, 0x0a]));
    const editor = new FileEditService(fs);
    const result = await editor.edit({
      path,
      displayPath: 'edit-bom.txt',
      old_string: 'b',
      new_string: 'c',
      replace_all: false,
    });
    expect(result).toEqual({ ok: true, count: 1 });
    expect(await readFile(path)).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a, 0x63, 0x0a]));
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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['response', 'visitor'])('stops replaying entries when the deadline expires during the %s', async (phase) => {
    let clock = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const fs = new RemoteFileSystem({
      call: async () => {
        if (phase === 'response') clock = 2_000;
        return { entries: [{ path: 'first.ts', kind: 'file' }, { path: 'second.ts', kind: 'file' }], truncated: false };
      },
      notify: () => {},
      onNotification: () => () => {},
      onDidClose: () => {},
    });
    const visited: string[] = [];

    const result = await fs.walk('/root', { deadlineMs: 2_000 }, (entry) => {
      visited.push(entry.path);
      clock = 2_000;
    });

    expect(visited).toEqual(phase === 'response' ? [] : ['first.ts']);
    expect(result).toEqual({ truncated: true });
  });

  it('honors the caller deadline before and during a remote walk', async () => {
    const calls: Array<{ method: string; timeoutMs?: number }> = [];
    const fs = new RemoteFileSystem({
      call: async (method, params) => {
        calls.push({ method, timeoutMs: (params as { timeoutMs: number }).timeoutMs });
        return { entries: [], truncated: false };
      },
      notify: () => {},
      onNotification: () => () => {},
      onDidClose: () => {},
    });

    const active = await fs.walk('/root', { deadlineMs: Date.now() + 1_000 }, () => {});
    const expired = await fs.walk('/root', { deadlineMs: Date.now() }, () => {});

    expect(active.truncated).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe(FS_WALK_METHOD);
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThanOrEqual(1_000);
    expect(expired).toEqual({ truncated: true });
  });

  it('walks nested directories depth-first in one rpc and prunes ignored subtrees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'remote-exec-walk-'));
    const { connection, loopback } = await connectInProcess();
    const methods: string[] = [];
    loopback.clientInput.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').trim().split('\n')) {
        if (line.length > 0) methods.push((JSON.parse(line) as { method?: string }).method ?? '');
      }
    });
    try {
      await mkdir(join(dir, 'src/nested'), { recursive: true });
      await mkdir(join(dir, 'node_modules/pkg'), { recursive: true });
      await writeFile(join(dir, 'src/nested/app.ts'), '');
      await writeFile(join(dir, 'node_modules/pkg/index.ts'), '');
      const fs = new RemoteFileSystem(connection);
      const paths: string[] = [];
      const result = await fs.walk(dir, { ignore: ['node_modules/'] }, (entry) => {
        paths.push(entry.path);
      });

      expect(paths).toEqual(['src', 'src/nested', 'src/nested/app.ts']);
      expect(result.truncated).toBe(false);
      expect(methods.filter((method) => method === FS_WALK_METHOD)).toHaveLength(1);
      expect(methods.filter((method) => method === FS_READ_DIRECTORY_METHOD)).toHaveLength(0);
    } finally {
      connection.close();
      await loopback.host.done;
      await rm(dir, { recursive: true, force: true });
    }
  });

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

describe('requireAbsolutePath', () => {
  it('asks Windows targets for a drive path', () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      for (const path of ['/c/work', '/tmp', '\\\\server\\share']) {
        expect(() => requireAbsolutePath({ path }, 'path')).toThrow('path must be an absolute Windows drive path such as C:\\work');
      }
      expect(requireAbsolutePath({ path: 'C:\\work' }, 'path')).toBe('C:\\work');
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
});
