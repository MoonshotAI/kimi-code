import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface FileMeta {
  readonly id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size: number;
  readonly created_at: string;
  readonly expires_at?: string;
}

export interface FileReadRange {
  readonly start: number;
  readonly end: number;
}

export interface SaveFileOptions {
  readonly name?: string;
  readonly mimeType?: string;
  readonly expiresInSec?: number;
}

export interface StoredFile {
  readonly meta: FileMeta;
  stream(range?: FileReadRange): AsyncIterable<Uint8Array>;
}

export const FILE_ID_PATTERN = /^f_[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}

interface FileIndex {
  readonly version: 1;
  readonly files: FileMeta[];
}

export class FileLibrary {
  private index: Map<string, FileMeta> | undefined;
  private loading: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async save(
    source: AsyncIterable<Uint8Array>,
    filename: string,
    options: SaveFileOptions = {},
  ): Promise<FileMeta> {
    await this.ensureIndex();
    await this.pruneExpired();
    const id = `f_${randomUUID()}`;
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, id);
    try {
      await pipeline(Readable.from(source), createWriteStream(path));
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    }
    const { size } = await stat(path);
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
    this.index!.set(id, meta);
    await this.writeIndex();
    return meta;
  }

  async open(id: string): Promise<StoredFile | undefined> {
    if (!isFileId(id)) return undefined;
    await this.ensureIndex();
    await this.pruneExpired();
    const meta = this.index!.get(id);
    if (meta === undefined) return undefined;
    const path = join(this.dir, id);
    try {
      if (!(await stat(path)).isFile()) return undefined;
    } catch (error) {
      if (isEnoent(error)) {
        this.index!.delete(id);
        await this.writeIndex();
        return undefined;
      }
      throw error;
    }
    return {
      meta,
      stream: (range) =>
        createReadStream(path, range === undefined ? {} : { start: range.start, end: range.end }),
    };
  }

  private ensureIndex(): Promise<void> {
    if (this.index !== undefined) return Promise.resolve();
    if (this.loading !== undefined) return this.loading;
    this.loading = this.loadIndex().finally(() => {
      this.loading = undefined;
    });
    return this.loading;
  }

  private async loadIndex(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(join(this.dir, 'index.json'), 'utf8');
    } catch (error) {
      if (isEnoent(error)) {
        this.index = new Map();
        return;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as FileIndex;
      const map = new Map<string, FileMeta>();
      if (Array.isArray(parsed.files)) {
        for (const entry of parsed.files) {
          if (isFileMeta(entry)) map.set(entry.id, entry);
        }
      }
      this.index = map;
    } catch {
      this.index = new Map();
    }
  }

  private async pruneExpired(): Promise<void> {
    const index = this.index;
    if (index === undefined) return;
    const now = Date.now();
    const expired = [...index.values()].filter(
      (meta) => meta.expires_at !== undefined && Date.parse(meta.expires_at) <= now,
    );
    if (expired.length === 0) return;
    for (const meta of expired) {
      index.delete(meta.id);
      await rm(join(this.dir, meta.id), { force: true }).catch(() => undefined);
    }
    await this.writeIndex().catch(() => undefined);
  }

  private async writeIndex(): Promise<void> {
    const write = this.writing.catch(() => undefined).then(async () => {
      const index = this.index;
      if (index === undefined) return;
      const payload: FileIndex = { version: 1, files: [...index.values()] };
      await mkdir(this.dir, { recursive: true });
      const path = join(this.dir, 'index.json');
      await writeFile(`${path}.tmp`, JSON.stringify(payload), 'utf8');
      await rename(`${path}.tmp`, path);
    });
    this.writing = write;
    await write;
  }
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

function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
