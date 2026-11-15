import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { join } from 'node:path';

import { artexEvidenceBlobsDir, artexEvidenceStagingDir } from './paths';

export const ARTEX_ARTIFACT_GC_GRACE_MS = 24 * 60 * 60 * 1000;
export const ARTEX_ARTIFACT_MAX_READ = 8 * 1024;

const HASH_RE = /^[0-9a-f]{64}$/;

export interface ArtexArtifactSnapshot {
  readonly hash: string;
  readonly length: number;
}

export interface ArtexArtifactRange {
  readonly data: Buffer;
  readonly total: number;
}

/**
 * sha256 content-addressed blob store under `.artex/evidence/blobs`. A body is
 * staged, fsynced and atomically renamed into place, so a stored hash always
 * names bytes that already verified; identical bodies dedup by hash. GC only
 * reaps blobs that no caller references AND that aged past the grace window, so a
 * body restored but not yet committed survives.
 */
export class FileArtexArtifactStore {
  readonly workspaceRoot: string;
  private readonly blobsDir: string;
  private readonly stagingDir: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
    this.blobsDir = artexEvidenceBlobsDir(workspaceRoot);
    this.stagingDir = artexEvidenceStagingDir(workspaceRoot);
  }

  /**
   * Writes one body and returns its hash + length. A body matching an existing
   * blob dedups (the grace window is refreshed so a restore is not reaped). A
   * mismatching expectedHash is rejected rather than stored silently.
   */
  async writeBody(body: Buffer, expectedHash?: string): Promise<ArtexArtifactSnapshot> {
    await mkdir(this.stagingDir, { recursive: true });
    const hash = createHash('sha256').update(body).digest('hex');
    if (expectedHash !== undefined && expectedHash !== '' && expectedHash !== hash) {
      throw new Error('artifact body hash mismatch');
    }
    const length = body.length;
    const path = this.hashPath(hash);
    const existing = await stat(path).catch(() => undefined);
    if (existing !== undefined) {
      await this.verifyFile(path, hash, length);
      const now = new Date();
      await utimes(path, now, now);
      return { hash, length };
    }
    const tmp = join(this.stagingDir, `body-${process.pid}-${randomUUID()}`);
    const handle = await open(tmp, 'wx');
    try {
      await handle.writeFile(body);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await mkdir(join(this.blobsDir, hash.slice(0, 2)), { recursive: true });
    try {
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      if (await stat(path).then(() => true).catch(() => false)) {
        await this.verifyFile(path, hash, length);
        return { hash, length };
      }
      throw error;
    }
    return { hash, length };
  }

  async exists(hash: string): Promise<boolean> {
    if (!HASH_RE.test(hash)) return false;
    return stat(this.hashPath(hash)).then(() => true).catch(() => false);
  }

  /** Returns the whole verified body, or undefined when the blob is missing. */
  async readBody(hash: string, length?: number): Promise<Buffer | undefined> {
    if (!HASH_RE.test(hash)) return undefined;
    const path = this.hashPath(hash);
    const body = await readFile(path).catch(() => undefined);
    if (body === undefined) return undefined;
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== hash || (length !== undefined && body.length !== length)) {
      throw new Error(`artifact body verification failed: ${hash}`);
    }
    return body;
  }

  /**
   * Reads at most `length` bytes of a blob from `offset`, reporting the total
   * size so a caller can page through a large body without loading it whole.
   */
  async blobRange(hash: string, offset: number, length: number): Promise<ArtexArtifactRange | undefined> {
    if (!HASH_RE.test(hash)) return undefined;
    const path = this.hashPath(hash);
    const info = await stat(path).catch(() => undefined);
    if (info === undefined) return undefined;
    const total = info.size;
    const start = Math.max(0, offset);
    if (start >= total) return { data: Buffer.alloc(0), total };
    const want = length <= 0 || start + length > total ? total - start : length;
    const handle = await open(path, 'r');
    try {
      const buf = Buffer.alloc(want);
      const { bytesRead } = await handle.read(buf, 0, want, start);
      return { data: buf.subarray(0, bytesRead), total };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reaps blobs no longer referenced. `liveHashes` are the hashes callers still
   * point at; anything else is removed only once it has aged past the grace
   * window, so a freshly staged-but-uncommitted body is never collected.
   */
  async collect(liveHashes: ReadonlySet<string>, now: number = Date.now()): Promise<number> {
    let removed = 0;
    for (const root of [this.blobsDir, this.stagingDir]) {
      removed += await this.sweep(root, liveHashes, now);
    }
    return removed;
  }

  private async sweep(root: string, liveHashes: ReadonlySet<string>, now: number): Promise<number> {
    let removed = 0;
    const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) return 0;
    for (const entry of entries) {
      const full = join(root, entry.name);
      if (entry.isDirectory()) {
        removed += await this.sweep(full, liveHashes, now);
        await rm(full, { recursive: false }).catch(() => undefined);
        continue;
      }
      const hash = entry.name.replace(/\.bin$/, '');
      if (liveHashes.has(hash)) continue;
      const info = await stat(full).catch(() => undefined);
      if (info === undefined) continue;
      if (now - info.mtimeMs < ARTEX_ARTIFACT_GC_GRACE_MS) continue;
      await rm(full, { force: true }).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  private hashPath(hash: string): string {
    if (!HASH_RE.test(hash)) throw new Error('invalid artifact hash');
    return join(this.blobsDir, hash.slice(0, 2), `${hash}.bin`);
  }

  private async verifyFile(path: string, hash: string, length: number): Promise<void> {
    const body = await readFile(path);
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== hash || body.length !== length) {
      throw new Error(`artifact body verification failed: ${hash}`);
    }
  }
}
