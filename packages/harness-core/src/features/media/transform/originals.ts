import { join } from 'pathe';

import type { OsFsPort } from '#/features/os/host/index';
import { sha256Hex } from '#/sha256';

const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
};

export interface PersistOriginalImageOptions {
  readonly dir: string;
  readonly fs: OsFsPort;
  readonly maxTotalBytes?: number;
}

export async function persistOriginalImage(
  bytes: Uint8Array,
  mimeType: string,
  options: PersistOriginalImageOptions,
): Promise<string | null> {
  if (bytes.length === 0) return null;
  const dir = options.dir;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  try {
    const hash = sha256Hex(bytes).slice(0, 32);
    const extension = MIME_EXTENSION[mimeType.trim().toLowerCase()] ?? 'img';
    const path = join(dir, `${hash}.${extension}`);
    const fs = options.fs;
    await fs.mkdir(dir, { recursive: true });

    const existing = await fs.stat(path).catch(() => null);
    if (existing === null || existing.size !== bytes.length) {
      await fs.writeBytes(path, bytes);
    }

    await sweepCache(fs, dir, maxTotalBytes);
    const persisted = await fs.stat(path).catch(() => null);
    return persisted === null ? null : path;
  } catch {
    return null;
  }
}

async function sweepCache(fs: OsFsPort, dir: string, maxTotalBytes: number): Promise<void> {
  const names = await fs.readdir(dir);
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  for (const { name } of names) {
    const path = join(dir, name);
    const info = await fs.stat(path).catch(() => null);
    if (info === null || !info.isFile || info.mtimeMs === undefined) continue;
    entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
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
