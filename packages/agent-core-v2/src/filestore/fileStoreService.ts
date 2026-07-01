/**
 * `filestore` domain (L2) — `IFileStore` implementation.
 *
 * Streams uploads into the `IBlobStorage` backend under the `files` scope and
 * keeps a JSON `FileMeta` index in the same backend under the `filestore`
 * scope. Enforces the 50 MiB upload cap while collecting the stream, prunes the
 * index when a referenced blob is missing, and hands downloads back as a lazy
 * `Readable` over `readStream`. Bound at Core scope.
 */

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import type { FileMeta } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBlobStorage, type IStorageService } from '#/storage';

import { fileNotFoundError, fileTooLargeError } from './errors';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  IFileStore,
  type GetResult,
  type SaveOptions,
} from './filestore';

const BLOB_SCOPE = 'files';
const INDEX_SCOPE = 'filestore';
const INDEX_KEY = 'index.json';
const FILE_ID_REGEX = /^f_[A-Za-z0-9][A-Za-z0-9_-]*$/;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface IndexFile {
  readonly version: 1;
  readonly files: FileMeta[];
}

function isFileId(value: string): boolean {
  return FILE_ID_REGEX.test(value);
}

function isFileMeta(value: unknown): value is FileMeta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const meta = value as Record<string, unknown>;
  return (
    typeof meta['id'] === 'string' &&
    isFileId(meta['id']) &&
    typeof meta['name'] === 'string' &&
    typeof meta['media_type'] === 'string' &&
    typeof meta['size'] === 'number' &&
    Number.isSafeInteger(meta['size']) &&
    meta['size'] >= 0 &&
    typeof meta['created_at'] === 'string' &&
    (meta['expires_at'] === undefined || typeof meta['expires_at'] === 'string')
  );
}

export class FileStoreService implements IFileStore {
  declare readonly _serviceBrand: undefined;

  private indexCache: Map<string, FileMeta> | undefined;
  private indexLoadPromise: Promise<void> | undefined;

  constructor(@IBlobStorage private readonly blobs: IStorageService) {}

  async save(source: Readable, filename: string, options: SaveOptions = {}): Promise<FileMeta> {
    await this.ensureIndex();

    const id = `f_${randomUUID()}`;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      bytes += buf.length;
      if (bytes > DEFAULT_MAX_UPLOAD_BYTES) {
        throw fileTooLargeError(bytes, DEFAULT_MAX_UPLOAD_BYTES);
      }
      chunks.push(buf);
    }
    const data = Buffer.concat(chunks);

    await this.blobs.write(BLOB_SCOPE, id, data, { atomic: true });

    const now = Date.now();
    const meta: FileMeta = {
      id,
      name: options.name ?? filename,
      media_type: options.mimeType ?? 'application/octet-stream',
      size: data.length,
      created_at: new Date(now).toISOString(),
      ...(options.expiresInSec !== undefined
        ? { expires_at: new Date(now + options.expiresInSec * 1000).toISOString() }
        : {}),
    };

    this.indexCache!.set(id, meta);
    await this.writeIndex();
    return meta;
  }

  async get(fileId: string): Promise<GetResult> {
    if (!isFileId(fileId)) {
      throw fileNotFoundError(fileId);
    }
    await this.ensureIndex();
    const meta = this.indexCache!.get(fileId);
    if (meta === undefined) {
      throw fileNotFoundError(fileId);
    }

    const present = await this.blobs.list(BLOB_SCOPE, fileId);
    if (!present.includes(fileId)) {
      this.indexCache!.delete(fileId);
      await this.writeIndex();
      throw fileNotFoundError(fileId);
    }

    return { meta, stream: Readable.from(this.blobs.readStream(BLOB_SCOPE, fileId)) };
  }

  async delete(fileId: string): Promise<void> {
    if (!isFileId(fileId)) {
      throw fileNotFoundError(fileId);
    }
    await this.ensureIndex();
    if (!this.indexCache!.has(fileId)) {
      throw fileNotFoundError(fileId);
    }
    this.indexCache!.delete(fileId);
    await this.blobs.delete(BLOB_SCOPE, fileId);
    await this.writeIndex();
  }

  private ensureIndex(): Promise<void> {
    if (this.indexCache !== undefined) return Promise.resolve();
    if (this.indexLoadPromise !== undefined) return this.indexLoadPromise;
    this.indexLoadPromise = this.loadIndex().finally(() => {
      this.indexLoadPromise = undefined;
    });
    return this.indexLoadPromise;
  }

  private async loadIndex(): Promise<void> {
    const raw = await this.blobs.read(INDEX_SCOPE, INDEX_KEY);
    if (raw === undefined) {
      this.indexCache = new Map();
      return;
    }
    try {
      const parsed = JSON.parse(textDecoder.decode(raw)) as IndexFile;
      const map = new Map<string, FileMeta>();
      if (parsed && Array.isArray(parsed.files)) {
        for (const f of parsed.files) {
          if (isFileMeta(f)) {
            map.set(f.id, f);
          }
        }
      }
      this.indexCache = map;
    } catch {
      this.indexCache = new Map();
    }
  }

  private async writeIndex(): Promise<void> {
    const cache = this.indexCache;
    if (cache === undefined) return;
    const payload: IndexFile = { version: 1, files: Array.from(cache.values()) };
    await this.blobs.write(INDEX_SCOPE, INDEX_KEY, textEncoder.encode(JSON.stringify(payload)), {
      atomic: true,
    });
  }
}

registerScopedService(
  LifecycleScope.Core,
  IFileStore,
  FileStoreService,
  InstantiationType.Delayed,
  'filestore',
);
