/**
 * File blob store — stage 3b of the kap-server Rust migration.
 *
 * Replaces the v2 `IFileService` for the web server's `/files` endpoints:
 * uploads land on disk under `<home>/server/files/<id>` with a JSON metadata
 * index (`<home>/server/files/index.json`). No agent-core-v2 dependency.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { join } from 'node:path';

export interface FileMeta {
  id: string;
  name: string;
  media_type: string;
  size: number;
  created_at: string;
  expires_at?: string;
}

export class FileBlobStore {
  private readonly dir: string;
  private readonly indexFile: string;

  constructor(homeDir: string) {
    this.dir = join(homeDir, 'server', 'files');
    this.indexFile = join(this.dir, 'index.json');
  }

  private async loadIndex(): Promise<Record<string, FileMeta>> {
    try {
      const raw = await readFile(this.indexFile, 'utf8');
      return JSON.parse(raw) as Record<string, FileMeta>;
    } catch {
      return {};
    }
  }

  private async saveIndex(index: Record<string, FileMeta>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.indexFile, JSON.stringify(index, null, 2), 'utf8');
  }

  private async pruneExpired(index: Record<string, FileMeta>): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, meta] of Object.entries(index)) {
      if (meta.expires_at !== undefined && new Date(meta.expires_at).getTime() < now) {
        delete index[id];
        changed = true;
        await rm(join(this.dir, id), { force: true }).catch(() => {});
      }
    }
    if (changed) await this.saveIndex(index);
  }

  /** Stream a multipart part to disk and record its metadata. */
  async save(
    stream: Readable,
    _filename: string,
    options: { name?: string; mimeType?: string; expiresInSec?: number } = {},
  ): Promise<FileMeta> {
    await mkdir(this.dir, { recursive: true });
    const index = await this.loadIndex();
    await this.pruneExpired(index);
    const id = randomBytes(16).toString('hex');
    const outPath = join(this.dir, id);
    const out = createWriteStream(outPath);
    await new Promise<void>((resolve, reject) => {
      stream.pipe(out);
      stream.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve());
    });
    const size = (await import('node:fs/promises')).stat(outPath).then((s) => s.size);
    const created = new Date().toISOString();
    const meta: FileMeta = {
      id,
      name: options.name ?? _filename,
      media_type: options.mimeType ?? 'application/octet-stream',
      size: await size,
      created_at: created,
      ...(options.expiresInSec !== undefined
        ? { expires_at: new Date(Date.now() + options.expiresInSec * 1000).toISOString() }
        : {}),
    };
    index[id] = meta;
    await this.saveIndex(index);
    return meta;
  }

  /** Metadata for a file; undefined when unknown or expired. */
  async getMeta(id: string): Promise<FileMeta | undefined> {
    const index = await this.loadIndex();
    await this.pruneExpired(index);
    return index[id];
  }

  /** Readable stream for a stored file (optionally a byte range). */
  stream(id: string, range?: { start: number; end: number }): Readable {
    return createReadStream(join(this.dir, id), range);
  }

  async delete(id: string): Promise<boolean> {
    const index = await this.loadIndex();
    if (index[id] === undefined) return false;
    delete index[id];
    await this.saveIndex(index);
    await rm(join(this.dir, id), { force: true }).catch(() => {});
    return true;
  }
}

/** Stable id for a text payload (e.g. derived file ids). */
export function contentHashId(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 32);
}
