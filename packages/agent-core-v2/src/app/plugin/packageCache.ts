import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { Error2, ErrorCodes } from '#/errors';

import { downloadZip } from './archive';

const ARCHIVE_CACHE_LIMIT_BYTES = 500 * 1024 * 1024;

interface ArchiveLoadOptions {
  readonly expectedSha256: string;
  readonly expectedPluginId?: string;
  readonly fetchImpl?: typeof fetch;
}

export class PluginPackageCache {
  private readonly root: string;
  private readonly loads = new Map<string, Promise<Buffer>>();

  constructor(kimiHomeDir: string) {
    this.root = path.join(kimiHomeDir, 'plugins', 'cache', 'archives');
  }

  async load(source: string, options: ArchiveLoadOptions): Promise<Buffer> {
    const expectedSha256 = options.expectedSha256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Invalid plugin archive SHA-256', {
        details: { expectedSha256: options.expectedSha256 },
      });
    }
    const existing = this.loads.get(expectedSha256);
    if (existing !== undefined) return existing;
    const load = this.loadShared(source, expectedSha256, options);
    this.loads.set(expectedSha256, load);
    try {
      return await load;
    } finally {
      if (this.loads.get(expectedSha256) === load) this.loads.delete(expectedSha256);
    }
  }

  private async loadShared(
    source: string,
    expectedSha256: string,
    options: ArchiveLoadOptions,
  ): Promise<Buffer> {
    const filePath = path.join(this.root, `${expectedSha256}.zip`);
    const cached = await readVerifiedArchive(filePath, expectedSha256);
    if (cached !== undefined) {
      const now = new Date();
      await utimes(filePath, now, now).catch(() => undefined);
      return cached;
    }
    const buffer = await downloadZip(source, undefined, options.fetchImpl);
    const actualSha256 = archiveSha256(buffer);
    if (actualSha256 !== expectedSha256) {
      throw new Error2(
        ErrorCodes.PLUGIN_LOAD_FAILED,
        `Plugin archive SHA-256 mismatch: expected ${expectedSha256}, got ${actualSha256}`,
        {
          details: {
            expectedSha256,
            actualSha256,
            expectedPluginId: options.expectedPluginId,
          },
        },
      );
    }
    await this.store(expectedSha256, buffer);
    return buffer;
  }

  private async store(sha256: string, buffer: Buffer): Promise<void> {
    if (buffer.byteLength > ARCHIVE_CACHE_LIMIT_BYTES) return;
    try {
      await mkdir(this.root, { recursive: true });
      const filePath = path.join(this.root, `${sha256}.zip`);
      const temporaryPath = path.join(this.root, `.${sha256}-${randomUUID()}.tmp`);
      try {
        await writeFile(temporaryPath, buffer);
        await rename(temporaryPath, filePath);
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
      await pruneArchiveCache(this.root);
    } catch {
      return;
    }
  }
}

function archiveSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function readVerifiedArchive(
  filePath: string,
  expectedSha256: string,
): Promise<Buffer | undefined> {
  let buffer: Buffer;
  try {
    buffer = await readFile(filePath);
  } catch {
    return undefined;
  }
  if (archiveSha256(buffer) === expectedSha256) return buffer;
  await rm(filePath, { force: true }).catch(() => undefined);
  return undefined;
}

async function pruneArchiveCache(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: Array<{ path: string; size: number; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.zip')) continue;
    const filePath = path.join(root, entry.name);
    try {
      const info = await stat(filePath);
      files.push({ path: filePath, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }
  let totalBytes = files.reduce((total, file) => total + file.size, 0);
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of files) {
    if (totalBytes <= ARCHIVE_CACHE_LIMIT_BYTES) break;
    try {
      await rm(file.path, { force: true });
      totalBytes -= file.size;
    } catch {
      continue;
    }
  }
}
