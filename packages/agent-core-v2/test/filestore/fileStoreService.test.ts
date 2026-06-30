/**
 * `FileStoreService` unit tests — exercise the store through its `IFileStore`
 * interface against an in-memory `IBlobStorage` backend.
 */

import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  FileErrors,
  FileStoreService,
  IFileStore,
} from '#/filestore';
import { IBlobStorage, InMemoryStorageService, type IStorageService } from '#/storage';

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

describe('FileStoreService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let backend: InMemoryStorageService;

  beforeEach(() => {
    disposables = new DisposableStore();
    backend = new InMemoryStorageService();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IBlobStorage, backend);
        reg.define(IFileStore, FileStoreService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  function store(): IFileStore {
    return ix.get(IFileStore);
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
    expect((await readAll(stream)).toString()).toBe('hello world');
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

  it('rejects an upload that exceeds the cap', async () => {
    const big = Buffer.alloc(DEFAULT_MAX_UPLOAD_BYTES + 1, 0);
    await expect(store().save(readable(big), 'big.bin')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_TOO_LARGE,
    });
    // No blob or index entry should have been written.
    expect(await backend.list('files')).toHaveLength(0);
  });

  it('prunes the index when the backing blob is missing', async () => {
    const meta = await store().save(readable('payload'), 'p.txt');
    await (backend as IStorageService).delete('files', meta.id);

    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
    // Index entry was pruned, so a second get is still a clean 404.
    await expect(store().get(meta.id)).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });

  it('persists the index across instances sharing the backend', async () => {
    const meta = await store().save(readable('durable'), 'durable.txt');

    // A fresh store over the same backend reloads the persisted index.
    const ix2 = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IBlobStorage, backend);
        reg.define(IFileStore, FileStoreService);
      },
    });
    const reloaded = ix2.get(IFileStore);
    const { meta: got, stream } = await reloaded.get(meta.id);
    expect(got.id).toBe(meta.id);
    expect((await readAll(stream)).toString()).toBe('durable');
  });

  it('skips invalid persisted index entries when loading the index', async () => {
    await backend.write('files', 'f_valid', Buffer.from('ok'));
    await backend.write('files', 'f_invalid', Buffer.from('bad'));
    await backend.write(
      'filestore',
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
            { id: 'f_invalid' },
          ],
        }),
      ),
    );

    const { meta, stream } = await store().get('f_valid');
    expect(meta.name).toBe('valid.txt');
    expect((await readAll(stream)).toString()).toBe('ok');
    await expect(store().get('f_invalid')).rejects.toMatchObject({
      code: FileErrors.codes.FILE_NOT_FOUND,
    });
  });
});
