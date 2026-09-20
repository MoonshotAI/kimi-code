import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { FileMeta, GetResult, IFileService } from '@moonshot-ai/agent-core-v2';
import type { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import type { EnvironmentPath } from '@moonshot-ai/agent-core-v2/environment/environment';

import {
  resolvePromptMediaFiles,
  type PromptAttachmentsTarget,
} from '../../src/lib/promptMedia';

const FRAME_CAP_BYTES = 64 * 1024 * 1024;

interface WriteCall {
  readonly path: string;
  readonly mode: 'truncate' | 'append';
  readonly data: Uint8Array;
}

function framePayloadBytes(data: Uint8Array): number {
  return Math.ceil(data.byteLength / 3) * 4;
}

function fakeEnvironmentFs(options: { failAfterOps?: { path: string; ops: number } } = {}) {
  const files = new Map<string, Uint8Array>();
  const writes: WriteCall[] = [];
  const removed: string[] = [];
  const opsPerPath = new Map<string, number>();
  const put = (path: string, data: Uint8Array, mode: 'truncate' | 'append'): void => {
    const ops = (opsPerPath.get(path) ?? 0) + 1;
    opsPerPath.set(path, ops);
    const fail = options.failAfterOps;
    if (fail !== undefined && fail.path === path && ops > fail.ops) {
      throw new Error('injected staging failure');
    }
    if (framePayloadBytes(data) > FRAME_CAP_BYTES) {
      throw new Error('message exceeds the frame cap');
    }
    writes.push({ path, mode, data });
    const existing = files.get(path);
    files.set(
      path,
      mode === 'append' && existing !== undefined ? Buffer.concat([existing, data]) : data,
    );
  };
  const fs = {
    mkdir: async () => undefined,
    stat: async (path: string) => {
      const data = files.get(path);
      if (data === undefined) throw new Error(`no such file: ${path}`);
      return { isFile: true, isDirectory: false, size: data.byteLength };
    },
    writeBytes: async (path: string, data: Uint8Array) => {
      put(path, data, 'truncate');
    },
    appendBytes: async (path: string, data: Uint8Array) => {
      put(path, data, 'append');
    },
    remove: async (path: string) => {
      removed.push(path);
      files.delete(path);
    },
  } as unknown as IHostFileSystem;
  return { files, writes, removed, fs };
}

const environmentPath: EnvironmentPath = {
  separator: '/',
  delimiter: ':',
  isAbsolute: (path) => path.startsWith('/'),
  join: (...paths) => paths.join('/'),
  relative: (_from, to) => to,
  resolve: (...paths) => paths.join('/'),
  basename: (path) => path.slice(path.lastIndexOf('/') + 1),
  dirname: (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)),
};

interface FakeFileEntry {
  readonly meta: FileMeta;
  readonly chunks: readonly (string | Uint8Array)[];
}

function fakeFileStore(entries: ReadonlyMap<string, FakeFileEntry>): IFileService {
  return {
    get: async (fileId: string): Promise<GetResult> => {
      const entry = entries.get(fileId);
      if (entry === undefined) throw new Error(`no such file: ${fileId}`);
      return { meta: entry.meta, stream: () => Readable.from(entry.chunks) };
    },
  } as unknown as IFileService;
}

function meta(id: string, name: string, size: number): FileMeta {
  return {
    id,
    name,
    media_type: 'application/octet-stream',
    size,
    created_at: new Date(0).toISOString(),
  };
}

function patternedBytes(size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) data[index] = index % 251;
  return data;
}

function targetFor(fs: IHostFileSystem): PromptAttachmentsTarget {
  return { dir: '/remote/tmp/kimi-code/attachments', fs, path: environmentPath };
}

function expectFrameSafe(writes: readonly WriteCall[]): void {
  for (const write of writes) {
    expect(framePayloadBytes(write.data)).toBeLessThanOrEqual(FRAME_CAP_BYTES);
  }
}

function expectStoredBytes(files: ReadonlyMap<string, Uint8Array>, path: string, expected: Uint8Array): void {
  const written = files.get(path);
  if (written === undefined) throw new Error(`nothing written to ${path}`);
  expect(written.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(written), Buffer.from(expected))).toBe(0);
}

describe('resolvePromptMediaFiles with an environment attachments target', () => {
  it('streams a large attachment in frame-safe chunks: first truncate, then append', async () => {
    const size = 50 * 1024 * 1024;
    const data = patternedBytes(size);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < size; offset += 3 * 1024 * 1024) {
      chunks.push(data.subarray(offset, offset + 3 * 1024 * 1024));
    }
    const store = fakeFileStore(
      new Map([['f_big', { meta: meta('f_big', 'big.bin', size), chunks }]]),
    );
    const fake = fakeEnvironmentFs();
    const result = await resolvePromptMediaFiles(
      [
        {
          type: 'file',
          file_id: 'f_big',
          name: 'big.bin',
          media_type: 'application/octet-stream',
          size,
        },
      ],
      store,
      '/cache',
      { resolveAttachmentsTarget: async () => targetFor(fake.fs) },
    );
    expect(result.attachments).toHaveLength(1);
    const target = result.attachments[0]!.path;
    expect(target).toBe('/remote/tmp/kimi-code/attachments/f_big-big.bin');
    expectStoredBytes(fake.files, target, data);
    expect(fake.writes.length).toBeGreaterThan(1);
    expect(fake.writes[0]!.mode).toBe('truncate');
    expect(fake.writes.slice(1).every((write) => write.mode === 'append')).toBe(true);
    expectFrameSafe(fake.writes);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: `Attached file "big.bin" (application/octet-stream, ${String(size)} bytes): ${target} — open it with the Read tool`,
    });
  });

  it('writes a small attachment with a single truncate write, bytes unchanged', async () => {
    const chunks: (string | Uint8Array)[] = ['hello ', new Uint8Array([119, 111, 114, 108, 100])];
    const expected = Buffer.concat([Buffer.from('hello '), Buffer.from([119, 111, 114, 108, 100])]);
    const store = fakeFileStore(
      new Map([['f_small', { meta: meta('f_small', 'small.txt', expected.byteLength), chunks }]]),
    );
    const fake = fakeEnvironmentFs();
    const result = await resolvePromptMediaFiles(
      [
        {
          type: 'file',
          file_id: 'f_small',
          name: 'small.txt',
          media_type: 'text/plain',
          size: expected.byteLength,
        },
      ],
      store,
      '/cache',
      { resolveAttachmentsTarget: async () => targetFor(fake.fs) },
    );
    const target = result.attachments[0]!.path;
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]!.mode).toBe('truncate');
    expectStoredBytes(fake.files, target, expected);
  });

  it('persists a large unsupported inline image in frame-safe chunks', async () => {
    const size = 20 * 1024 * 1024;
    const bytes = patternedBytes(size);
    bytes.fill(0x61, 0, 4096);
    const base64 = Buffer.from(bytes).toString('base64');
    const fake = fakeEnvironmentFs();
    const result = await resolvePromptMediaFiles(
      [
        {
          type: 'image',
          name: 'big.tiff',
          source: { kind: 'base64', media_type: 'image/tiff', data: base64 },
        },
      ],
      fakeFileStore(new Map()),
      '/cache',
      { resolveAttachmentsTarget: async () => targetFor(fake.fs) },
    );
    expect(result.attachments).toHaveLength(1);
    const target = result.attachments[0]!.path;
    expectStoredBytes(fake.files, target, bytes);
    expect(fake.writes.length).toBeGreaterThan(1);
    expect(fake.writes[0]!.mode).toBe('truncate');
    expect(fake.writes.slice(1).every((write) => write.mode === 'append')).toBe(true);
    expectFrameSafe(fake.writes);
  });

  it('removes staged remote files when a later part fails to stage', async () => {
    const data = patternedBytes(11);
    const store = fakeFileStore(
      new Map([['f_ok', { meta: meta('f_ok', 'ok.txt', data.byteLength), chunks: [data] }]]),
    );
    const fake = fakeEnvironmentFs();
    const target = '/remote/tmp/kimi-code/attachments/f_ok-ok.txt';
    await expect(
      resolvePromptMediaFiles(
        [
          { type: 'file', file_id: 'f_ok', name: 'ok.txt', media_type: 'text/plain', size: data.byteLength },
          { type: 'file', file_id: 'f_missing', name: 'missing.txt', media_type: 'text/plain', size: 1 },
        ],
        store,
        '/cache',
        { resolveAttachmentsTarget: async () => targetFor(fake.fs) },
      ),
    ).rejects.toThrow('no such file: f_missing');
    expect(fake.files.size).toBe(0);
    expect(fake.removed).toEqual([target]);
  });

  it('removes a partially staged remote file when the write fails mid-stream', async () => {
    const size = 20 * 1024 * 1024;
    const data = patternedBytes(size);
    const store = fakeFileStore(
      new Map([['f_big', { meta: meta('f_big', 'big.bin', size), chunks: [data] }]]),
    );
    const target = '/remote/tmp/kimi-code/attachments/f_big-big.bin';
    const fake = fakeEnvironmentFs({ failAfterOps: { path: target, ops: 1 } });
    await expect(
      resolvePromptMediaFiles(
        [{ type: 'file', file_id: 'f_big', name: 'big.bin', media_type: 'application/octet-stream', size }],
        store,
        '/cache',
        { resolveAttachmentsTarget: async () => targetFor(fake.fs) },
      ),
    ).rejects.toThrow('injected staging failure');
    expect(fake.files.size).toBe(0);
    expect(fake.removed).toEqual([target]);
  });

  it('keeps a pre-existing staged file the failing call did not write', async () => {
    const data = patternedBytes(13);
    const store = fakeFileStore(
      new Map([['f_seed', { meta: meta('f_seed', 'seed.txt', data.byteLength), chunks: [data] }]]),
    );
    const fake = fakeEnvironmentFs();
    const target = '/remote/tmp/kimi-code/attachments/f_seed-seed.txt';
    fake.files.set(target, data);
    await expect(
      resolvePromptMediaFiles(
        [
          { type: 'file', file_id: 'f_seed', name: 'seed.txt', media_type: 'text/plain', size: data.byteLength },
          { type: 'file', file_id: 'f_missing', name: 'missing.txt', media_type: 'text/plain', size: 1 },
        ],
        store,
        '/cache',
        { resolveAttachmentsTarget: async () => targetFor(fake.fs) },
      ),
    ).rejects.toThrow('no such file: f_missing');
    expect(fake.removed).toEqual([]);
    expectStoredBytes(fake.files, target, data);
  });
});
