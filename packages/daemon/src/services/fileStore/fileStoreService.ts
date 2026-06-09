/**
 * `FileStore` — implementation of `IFileStore`.
 */

import { createWriteStream, promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

import { ulid } from 'ulid';

import { Disposable } from '@moonshot-ai/agent-core';

import type { FileMeta } from '@moonshot-ai/protocol';
import { IEnvironmentService } from '@moonshot-ai/services';

import { ILogService } from '#/services/logger';
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  FileNotFoundError,
  FileTooLargeError,
  IFileStore,
} from './fileStore';

interface IndexFile {
  version: 1;
  files: FileMeta[];
}

export class FileStore extends Disposable implements IFileStore {
  readonly _serviceBrand: undefined;

  private readonly baseDir: string;
  private readonly indexPath: string;
  private readonly maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES;
  private indexCache: Map<string, FileMeta> | undefined;
  private indexLoadPromise: Promise<void> | undefined;

  constructor(
    @IEnvironmentService env: IEnvironmentService,
    @ILogService private readonly logger: ILogService,
  ) {
    super();
    this.baseDir = join(env.homeDir, 'files');
    this.indexPath = join(this.baseDir, 'index.json');
  }

  async save(
    source: Readable,
    filename: string,
    options: import('./fileStore.js').SaveOptions = {},
  ): Promise<FileMeta> {
    await this.ensureIndex();
    const fileId = `f_${ulid()}`;
    const blobPath = join(this.baseDir, fileId);

    // Track bytes during streaming to enforce the size cap. We
    // intercept on the source via `'data'`, abort the writable if the
    // limit trips, and `unlink` the partial blob in the catch path.
    let bytes = 0;
    let aborted = false;
    let abortReason: Error | undefined;

    const writable = createWriteStream(blobPath);

    source.on('data', (chunk: Buffer | string) => {
      const len = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      bytes += len;
      if (!aborted && bytes > this.maxUploadBytes) {
        aborted = true;
        abortReason = new FileTooLargeError(bytes, this.maxUploadBytes);
        // `destroy(err)` propagates the error through `pipeline`.
        source.destroy(abortReason);
      }
    });

    try {
      await pipeline(source, writable);
    } catch (err) {
      // Clean up any partial blob — best-effort, swallow ENOENT.
      try {
        await fsp.unlink(blobPath);
      } catch {
        /* ignore */
      }
      if (abortReason) throw abortReason;
      throw err;
    }

    // Re-stat to capture the final size on disk (the pipeline may have
    // counted differently if upstream re-chunked).
    const stat = await fsp.stat(blobPath);
    const meta: FileMeta = {
      id: fileId,
      name: options.name ?? filename,
      media_type: options.mimeType ?? 'application/octet-stream',
      size: stat.size,
      created_at: new Date().toISOString(),
      ...(options.expiresInSec !== undefined
        ? {
            expires_at: new Date(
              Date.now() + options.expiresInSec * 1000,
            ).toISOString(),
          }
        : {}),
    };

    this.indexCache!.set(meta.id, meta);
    await this.writeIndex();
    return meta;
  }

  async get(fileId: string): Promise<import('./fileStore.js').GetResult> {
    await this.ensureIndex();
    const meta = this.indexCache!.get(fileId);
    if (!meta) {
      throw new FileNotFoundError(fileId);
    }
    const blobPath = join(this.baseDir, fileId);
    // Verify the blob actually exists; if it disappeared on disk we
    // raise FileNotFoundError too (treat the missing blob as
    // equivalent to a missing id from the client's POV).
    try {
      await fsp.access(blobPath);
    } catch {
      this.logger.warn(
        { fileId },
        'file index says present but blob missing; reporting 40407',
      );
      this.indexCache!.delete(fileId);
      await this.writeIndex();
      throw new FileNotFoundError(fileId);
    }
    return { meta, blobPath };
  }

  async delete(fileId: string): Promise<void> {
    await this.ensureIndex();
    if (!this.indexCache!.has(fileId)) {
      throw new FileNotFoundError(fileId);
    }
    const blobPath = join(this.baseDir, fileId);
    this.indexCache!.delete(fileId);
    try {
      await fsp.unlink(blobPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Restore the index entry so the next call can re-attempt.
        // We don't have the meta here; re-throw to surface as 50001.
        throw err;
      }
      // ENOENT — blob missing but index had it. Continue (we've
      // already dropped the index entry); the writeIndex below makes
      // the deletion stick.
    }
    await this.writeIndex();
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Lazy index loader. Concurrency-safe (a second call before the
   * first resolves returns the same in-flight Promise).
   */
  private ensureIndex(): Promise<void> {
    if (this.indexCache !== undefined) return Promise.resolve();
    if (this.indexLoadPromise !== undefined) return this.indexLoadPromise;
    this.indexLoadPromise = this.loadIndex().finally(() => {
      this.indexLoadPromise = undefined;
    });
    return this.indexLoadPromise;
  }

  private async loadIndex(): Promise<void> {
    await fsp.mkdir(this.baseDir, { recursive: true });
    let raw: string;
    try {
      raw = await fsp.readFile(this.indexPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // First-run: empty index.
        this.indexCache = new Map();
        return;
      }
      throw err;
    }
    let parsed: IndexFile;
    try {
      parsed = JSON.parse(raw) as IndexFile;
    } catch (err) {
      this.logger.warn(
        { err: String(err) },
        'file-store index.json malformed; starting empty',
      );
      this.indexCache = new Map();
      return;
    }
    const map = new Map<string, FileMeta>();
    if (parsed && Array.isArray(parsed.files)) {
      for (const f of parsed.files) {
        if (f && typeof f.id === 'string') {
          map.set(f.id, f);
        }
      }
    }
    this.indexCache = map;
  }

  private async writeIndex(): Promise<void> {
    const cache = this.indexCache;
    if (!cache) return;
    const payload: IndexFile = {
      version: 1,
      files: Array.from(cache.values()),
    };
    await fsp.mkdir(this.baseDir, { recursive: true });
    const tmpPath = `${this.indexPath}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fsp.rename(tmpPath, this.indexPath);
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this.indexCache = undefined;
    super.dispose();
  }
}
