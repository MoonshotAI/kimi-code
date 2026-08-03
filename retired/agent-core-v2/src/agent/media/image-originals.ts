/**
 * `media` domain (L4) — content-addressed store for pre-compression image originals.
 *
 * When an ingestion point (MCP tool result, pasted image, inline base64
 * upload) compresses an image that exists only in memory, the original bytes
 * would be gone for good — the model could never zoom into a detail the
 * downsampled copy lost. This module persists those originals so the
 * compression caption can point at a real path the model can read back with
 * `ReadMediaFile` (typically with `region`).
 *
 * Placement: callers that know their session pass
 * `{ dir: sessionMediaOriginalsDir(sessionDir) }` so originals live at
 * `<sessionDir>/media-originals/` — owned by the session, cleaned up with it,
 * and immune to OS temp reaping. The shared temp-dir cache
 * ({@link originalImageCacheDir}) is only the fallback for call sites with no
 * session context.
 *
 * Design notes:
 *  - Content-addressed (sha256): duplicate pastes/results reuse one file and
 *    repeated writes are idempotent.
 *  - Best effort: any filesystem failure returns null; callers then emit a
 *    caption without a readback path. Persistence must never block a prompt.
 *  - Size-capped: after each write the store is swept oldest-first (mtime)
 *    until it fits {@link DEFAULT_MAX_TOTAL_BYTES}, so long sessions cannot
 *    fill the disk.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  readonly dir?: string;
  readonly maxTotalBytes?: number;
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
  const dir = options.dir ?? originalImageCacheDir();
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  try {
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
    const extension = MIME_EXTENSION[mimeType.trim().toLowerCase()] ?? 'img';
    const path = join(dir, `${hash}.${extension}`);
    await mkdir(dir, { recursive: true });

    const existing = await stat(path).catch(() => null);
    if (existing === null || existing.size !== bytes.length) {
      await writeFile(path, bytes);
    }

    await sweepCache(dir, maxTotalBytes);
    const persisted = await stat(path).catch(() => null);
    return persisted === null ? null : path;
  } catch {
    return null;
  }
}

async function sweepCache(dir: string, maxTotalBytes: number): Promise<void> {
  const names = await readdir(dir);
  const entries: { path: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    entries.push({ path, size: info.size, mtimeMs: info.mtimeMs });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= maxTotalBytes) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= maxTotalBytes) break;
    await unlink(entry.path).catch(() => undefined);
    total -= entry.size;
  }
}
