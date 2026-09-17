import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { RuntimePath } from '#/runtime/runtime';

const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const ORIGINAL_WRITE_CHUNK_BYTES = 16 * 1024 * 1024;

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
};

type OriginalsFs = Pick<IHostFileSystem, 'mkdir' | 'writeBytes' | 'stat' | 'readdir' | 'remove'> & {
  appendBytes?(path: string, data: Uint8Array): Promise<void>;
};

const nodeFs: OriginalsFs = {
  mkdir: async (path, options) => {
    await mkdir(path, { recursive: options?.recursive ?? false });
  },
  writeBytes: (path, data) => writeFile(path, data),
  stat: async (path) => {
    const s = await stat(path);
    return {
      isFile: s.isFile(),
      isDirectory: s.isDirectory(),
      size: s.size,
      mtimeMs: s.mtimeMs,
    };
  },
  readdir: async (path) =>
    (await readdir(path, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
    })),
  remove: (path) => unlink(path),
};

const hostPath: Pick<RuntimePath, 'join'> = { join };

export interface PersistOriginalImageOptions {
  readonly dir?: string;
  readonly maxTotalBytes?: number;
  readonly fs?: OriginalsFs;
  readonly path?: Pick<RuntimePath, 'join'>;
}

export function originalImageCacheDir(): string {
  return join(tmpdir(), 'kimi-code-original-images');
}

export function sessionMediaOriginalsDir(sessionDir: string): string {
  return join(sessionDir, 'media-originals');
}

export async function persistOriginalImage(
  bytes: Uint8Array,
  mimeType: string,
  options: PersistOriginalImageOptions = {},
): Promise<string | null> {
  if (bytes.length === 0) return null;
  const fs = options.fs ?? nodeFs;
  const dir = options.dir ?? originalImageCacheDir();
  const pathClass = options.path ?? hostPath;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  try {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const extension = MIME_EXTENSION[mimeType.trim().toLowerCase()] ?? 'img';
    const filePath = pathClass.join(dir, `${hash}.${extension}`);
    await fs.mkdir(dir, { recursive: true });

    const existing = await fs.stat(filePath).catch(() => null);
    if (existing === null || existing.size !== bytes.length) {
      await writeOriginalBytes(fs, filePath, bytes);
    }

    await sweepCache(fs, dir, maxTotalBytes, pathClass);
    const persisted = await fs.stat(filePath).catch(() => null);
    return persisted === null ? null : filePath;
  } catch {
    return null;
  }
}

async function writeOriginalBytes(
  fs: OriginalsFs,
  path: string,
  data: Uint8Array,
): Promise<void> {
  if (typeof fs.appendBytes !== 'function' || data.byteLength <= ORIGINAL_WRITE_CHUNK_BYTES) {
    await fs.writeBytes(path, data);
    return;
  }
  const appendBytes = fs.appendBytes.bind(fs);
  await fs.writeBytes(path, data.subarray(0, ORIGINAL_WRITE_CHUNK_BYTES));
  for (
    let offset = ORIGINAL_WRITE_CHUNK_BYTES;
    offset < data.byteLength;
    offset += ORIGINAL_WRITE_CHUNK_BYTES
  ) {
    await appendBytes(path, data.subarray(offset, offset + ORIGINAL_WRITE_CHUNK_BYTES));
  }
}

async function sweepCache(
  fs: OriginalsFs,
  dir: string,
  maxTotalBytes: number,
  pathClass: Pick<RuntimePath, 'join'>,
): Promise<void> {
  const names = await fs.readdir(dir);
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  for (const entry of names) {
    if (!entry.isFile) continue;
    const path = pathClass.join(dir, entry.name);
    const info = await fs.stat(path).catch(() => null);
    if (info === null || !info.isFile) continue;
    entries.push({ path, size: info.size, mtimeMs: info.mtimeMs ?? 0 });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxTotalBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxTotalBytes) break;
    await fs.remove(entry.path).catch(() => undefined);
    total -= entry.size;
  }
}
