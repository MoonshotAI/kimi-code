/**
 * `FileServiceImpl` unit tests — exercise the service through its `IFileService`
 * interface against an in-memory `IBlobStore` backend.
 */

import { Readable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { DEFAULT_MAX_UPLOAD_BYTES, FileErrors, IFileService } from '#/app/file/fileService';
import { FileServiceImpl } from '#/app/file/fileServiceImpl';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';

function readable(data: string | Buffer): Readable {
  return Readable.from([typeof data === 'string' ? Buffer.from(data) : data]);
}

const textEncoder = new TextEncoder();

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

describe('FileServiceImpl', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let backend: InMemoryStorageService;

  beforeEach(() => {
    disposables = new DisposableStore();
    backend = new InMemoryStorageService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
  });

  afterEach(() => disposables.dispose());

  function store(): IFileService {
    return ix.get(IFileService);
  }

  it('saves a file and reads its bytes back', async () => {
    const meta = await store().save(readable('hello world'), 'hello.txt', {
      mimeType: 'text/plain',
    });

    expect(meta.name).toBe('hello.txt');
    expect(meta.media_type).toBe('text/plain');
    expect(meta.size).toBe(Buffer.byteLength('hello world'));
    expect(meta.id.startsWith('f_')).toBe(true);

    const { meta: got, stream } = await store().get(meta.id);
    expect(got).toEqual(meta);
    expect((await readAll(stream())).toString()).toBe('hello world');
  });

  it('honors the name override and records expires_at', async () => {
    const meta = await store().save(readable('data'), 'original.bin', {
      name: 'renamed.bin',
      mimeType: 'application/octet-stream',
      expiresInSec: 60,
    });

    expect(meta.name).toBe('renamed.bin');
    expect(meta.expires_at).toBeDefined();
    expect(Date.parse(meta.expires_at!)).toBeGreaterThan(Date.parse(meta.created_at));
  });

  it('throws file.not_found for an unknown id on get', async () => {
    await expect(store().get('f_does_not_exist')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('deletes a file and then reports not found', async () => {
    const meta = await store().save(readable('bye'), 'bye.txt');
    await store().delete(meta.id);

    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('throws file.not_found when deleting an unknown id', async () => {
    await expect(store().delete('f_missing')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('treats traversal-looking file ids as not found', async () => {
    await expect(store().get('f_../outside')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(store().delete('f_../outside')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('rejects an upload that exceeds the cap', async () => {
    const big = Buffer.alloc(DEFAULT_MAX_UPLOAD_BYTES + 1, 0);
    await expect(store().save(readable(big), 'big.bin')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_TOO_LARGE,
    });
    expect(await backend.list('files')).toHaveLength(0);
  });

  it('prunes the index when the backing blob is missing', async () => {
    const meta = await store().save(readable('payload'), 'p.txt');
    await (backend as IFileSystemStorageService).delete('files', meta.id);

    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('persists the index across instances sharing the backend', async () => {
    const meta = await store().save(readable('durable'), 'durable.txt');

    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IFileSystemStorageService, backend);
        reg.define(IBlobStore, BlobStoreService);
        reg.define(IFileService, FileServiceImpl);
      },
    });
    const reloaded = ix2.get(IFileService);
    const { meta: got, stream } = await reloaded.get(meta.id);
    expect(got.id).toBe(meta.id);
    expect((await readAll(stream())).toString()).toBe('durable');
  });

  it('opens ranged streams when the storage backend is file-backed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kimi-file-service-'));
    try {
      const ix2 = createServices(disposables, {
        additionalServices: (reg) => {
          reg.defineInstance(IFileSystemStorageService, new FileStorageService(dir));
          reg.define(IBlobStore, BlobStoreService);
          reg.define(IFileService, FileServiceImpl);
        },
      });
      const service = ix2.get(IFileService);

      const meta = await service.save(readable('local bytes'), 'local.txt');
      const got = await service.get(meta.id);

      expect((await readAll(got.stream())).toString()).toBe('local bytes');
      expect((await readAll(got.stream({ start: 6, end: 10 }))).toString()).toBe('bytes');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips invalid persisted index entries when loading the index', async () => {
    await backend.write('files', 'f_valid', Buffer.from('ok'));
    await backend.write('files', 'f_invalid', Buffer.from('bad'));
    await backend.write(
      'file',
      'index.json',
      textEncoder.encode(
        JSON.stringify({
          version: 1,
          files: [
            {
              id: 'f_valid',
              name: 'valid.txt',
              media_type: 'text/plain',
              size: 2,
              created_at: new Date(0).toISOString(),
            },
            {
              id: 'f_../outside',
              name: 'outside.txt',
              media_type: 'text/plain',
              size: 3,
              created_at: new Date(0).toISOString(),
            },
            { id: 'f_invalid' },
          ],
        }),
      ),
    );

    const { meta, stream } = await store().get('f_valid');
    expect(meta.name).toBe('valid.txt');
    expect((await readAll(stream())).toString()).toBe('ok');
    await expect(store().get('f_invalid')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    await expect(store().get('f_../outside')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });
});
