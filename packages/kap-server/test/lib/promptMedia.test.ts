import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { FileMeta, GetResult, IFileService } from '@moonshot-ai/agent-core-v2';
import type { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import type { EnvironmentPath } from '@moonshot-ai/agent-core-v2/environment/environment';

import {
  resolvePromptMediaFiles,
  type PromptAttachmentsTarget,
} from '../../src/lib/promptMedia';

function fakeEnvironmentFs() {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const put = (path: string, data: Uint8Array, mode: 'truncate' | 'append'): void => {
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
    writeBytes: async (path: string, data: Uint8Array | AsyncIterable<Uint8Array>) => {
      if (data instanceof Uint8Array) {
        put(path, data, 'truncate');
        return;
      }
      files.set(path, new Uint8Array(0));
      for await (const chunk of data) put(path, chunk, 'append');
    },
    remove: async (path: string) => {
      removed.push(path);
      files.delete(path);
    },
  } as unknown as IHostFileSystem;
  return { files, removed, fs };
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
  readonly chunks: readonly Uint8Array[] | AsyncIterable<Uint8Array>;
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

function expectStoredBytes(files: ReadonlyMap<string, Uint8Array>, path: string, expected: Uint8Array): void {
  const written = files.get(path);
  if (written === undefined) throw new Error(`nothing written to ${path}`);
  expect(written.byteLength).toBe(expected.byteLength);
  expect(Buffer.compare(Buffer.from(written), Buffer.from(expected))).toBe(0);
}

describe('resolvePromptMediaFiles with an environment attachments target', () => {
  it('preserves the contents of a large attachment', async () => {
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
    expect(result.content[0]).toEqual({
      type: 'text',
      text: `Attached file "big.bin" (application/octet-stream, ${String(size)} bytes): ${target} — open it with the Read tool`,
    });
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
