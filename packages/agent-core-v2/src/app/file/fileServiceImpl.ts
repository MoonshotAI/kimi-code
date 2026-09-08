import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IBlobStore } from '#/persistence/interface/blobStore';
import {
  IFileService,
  fileNotFoundError,
  isFileId,
  type FileMeta,
  type FileReadRange,
  type GetResult,
  type SaveOptions,
} from './fileService';

const BLOB_SCOPE = 'files';
const INDEX_SCOPE = 'file';
const INDEX_KEY = 'index.json';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

interface IndexFile {
  readonly version: 1;
  readonly files: FileMeta[];
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

export class FileServiceImpl implements IFileService {
  declare readonly _serviceBrand: undefined;

  private indexCache: Map<string, FileMeta> | undefined;
  private indexLoadPromise: Promise<void> | undefined;
  private indexWritePromise: Promise<void> = Promise.resolve();

  constructor(@IBlobStore private readonly blobs: IBlobStore) {}

  async save(source: Readable, filename: string, options: SaveOptions = {}): Promise<FileMeta> {
    await this.ensureIndex();
    await this.pruneExpired();

    const id = `f_${randomUUID()}`;
    let size = 0;
    const counting = async function* (): AsyncIterable<Uint8Array> {
      for await (const chunk of source) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buf.length;
        yield buf;
      }
    };
    try {
      await this.blobs.putStream(BLOB_SCOPE, id, counting());
    } catch (error) {
      await this.blobs.delete(BLOB_SCOPE, id).catch(() => undefined);
      throw error;
    }

    const now = Date.now();
    const meta: FileMeta = {
      id,
      name: options.name ?? filename,
      media_type: options.mimeType ?? 'application/octet-stream',
      size,
      created_at: new Date(now).toISOString(),
      expires_at:
        options.expiresInSec === undefined
          ? undefined
          : new Date(now + options.expiresInSec * 1000).toISOString(),
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
    await this.pruneExpired();
    const meta = this.indexCache!.get(fileId);
    if (meta === undefined) {
      throw fileNotFoundError(fileId);
    }

    const present = await this.blobs.has(BLOB_SCOPE, fileId);
    if (!present) {
      this.indexCache!.delete(fileId);
      await this.writeIndex();
      throw fileNotFoundError(fileId);
    }

    return {
      meta,
      stream: (range?: FileReadRange) =>
        Readable.from(this.blobs.getStream(BLOB_SCOPE, fileId, range)),
    };
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
    const raw = await this.blobs.get(INDEX_SCOPE, INDEX_KEY);
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
      await this.pruneExpired();
    } catch {
      this.indexCache = new Map();
    }
  }

  private async pruneExpired(): Promise<void> {
    const cache = this.indexCache;
    if (cache === undefined) return;
    const now = Date.now();
    const expired = [...cache.values()].filter(
      (meta) => meta.expires_at !== undefined && Date.parse(meta.expires_at) <= now,
    );
    if (expired.length === 0) return;
    for (const meta of expired) {
      cache.delete(meta.id);
      await this.blobs.delete(BLOB_SCOPE, meta.id).catch(() => undefined);
    }
    await this.writeIndex().catch(() => undefined);
  }

  private async writeIndex(): Promise<void> {
    const write = this.indexWritePromise.catch(() => undefined).then(async () => {
      const cache = this.indexCache;
      if (cache === undefined) return;
      const payload: IndexFile = { version: 1, files: Array.from(cache.values()) };
      await this.blobs.put(INDEX_SCOPE, INDEX_KEY, textEncoder.encode(JSON.stringify(payload)));
    });
    this.indexWritePromise = write;
    await write;
  }
}

registerScopedService(
  LifecycleScope.App,
  IFileService,
  FileServiceImpl,
  ScopeActivation.OnScopeCreated,
  'file',
);
