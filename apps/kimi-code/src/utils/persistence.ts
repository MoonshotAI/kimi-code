/**
 * Small persistence helpers for CLI-owned data files.
 *
 * This module is intentionally for non-config files only. User-facing
 * configuration is owned by core/SDK; do not route `config.toml` through
 * these helpers.
 */

import { appendFile, link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import type { z } from 'zod';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Hard links need filesystem support: FAT/exFAT (and some network mounts)
 * answer link() with ENOTSUP/ENOSYS/EPERM instead.
 */
function isHardLinkUnsupported(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOTSUP' || code === 'ENOSYS' || code === 'EPERM';
}

function assertNonConfigWrite(filePath: string): void {
  if (basename(filePath) === 'config.toml') {
    throw new Error(
      'CLI persistence helpers must not write config.toml; use core/SDK config APIs.',
    );
  }
}

function tempPathFor(filePath: string): string {
  const dir = dirname(filePath);
  const base = basename(filePath);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  return join(dir, `.${base}.${nonce}.tmp`);
}

export async function readJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return fallback;
    throw error;
  }
  const parsed = JSON.parse(raw) as unknown;
  return schema.parse(parsed);
}

export async function writeJsonFile<T>(
  filePath: string,
  schema: z.ZodType<T>,
  value: T,
): Promise<void> {
  assertNonConfigWrite(filePath);
  const parsed = schema.parse(value);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = tempPathFor(filePath);
  try {
    await writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf-8');
    await rename(tmpPath, filePath);
  } catch (error) {
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
}

/**
 * Create `filePath` with `content` only while the path is still free —
 * atomically, and throwing EEXIST when it is already taken.
 *
 * Primary primitive: hard-link a fully written temp file into place, so the
 * destination is never observable in an empty/partial state. Filesystems
 * without hard-link support (FAT/exFAT, some network mounts) fall back to an
 * exclusive create + write — whose create→write gap IS observable, so readers
 * of such files must grant young unparseable content a publish grace before
 * treating it as corrupt (see the update install lock for an example).
 */
export async function createFileIfAbsent(filePath: string, content: string): Promise<void> {
  assertNonConfigWrite(filePath);
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = tempPathFor(filePath);
  await writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    await link(tmpPath, filePath);
  } catch (error) {
    if (!isHardLinkUnsupported(error)) throw error;
    await writeFile(filePath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function readJsonlFile<T>(
  filePath: string,
  lineSchema: z.ZodType<T>,
): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }

  const entries: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const result = lineSchema.safeParse(parsed);
      if (result.success) entries.push(result.data);
    } catch {
      // JSONL is append-only user data; tolerate bad rows and keep the rest.
    }
  }
  return entries;
}

export async function appendJsonlLine<T>(
  filePath: string,
  lineSchema: z.ZodType<T>,
  value: T,
): Promise<void> {
  assertNonConfigWrite(filePath);
  const parsed = lineSchema.parse(value);
  await mkdir(dirname(filePath), { recursive: true });
  await appendFile(filePath, `${JSON.stringify(parsed)}\n`, 'utf-8');
}
