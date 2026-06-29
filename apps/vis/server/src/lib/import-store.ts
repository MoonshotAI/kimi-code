// apps/vis/server/src/lib/import-store.ts
//
// Imported debug bundles (`/export-debug-zip` zips) live under
// `<home>/imported/<importId>/`, unzipped to the same on-disk shape as a real
// session directory (state.json, agents/<id>/wire.jsonl, tasks/, cron/, logs/)
// plus the bundle's `manifest.json`. Because the layout matches a session
// directory, every existing read path (wire / context / tasks / cron / blobs /
// logs) works against an imported session once `session-store` resolves its
// directory — see `findSessionDir`.
//
// This module owns ONLY: id allocation, safe extraction, validation, the
// vis-side `import-meta.json` sidecar, enumeration, and deletion. Summary /
// detail construction stays in `session-store` so imported and local sessions
// share one code path.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ImportInfo, ImportManifest } from './agent-record-types';
import { extractZip, ZipImportError } from './zip-import';

const IMPORT_ID_RE = /^imp_[0-9a-f]{12}$/;
const META_FILE = 'import-meta.json';

export function isImportId(id: string): boolean {
  return IMPORT_ID_RE.test(id);
}

export function importedRootOf(home: string): string {
  return join(home, 'imported');
}

export function importedDirOf(home: string, importId: string): string {
  if (!isImportId(importId)) throw new ZipImportError(`invalid import id: "${importId}"`);
  return join(importedRootOf(home), importId);
}

function newImportId(): string {
  return `imp_${randomBytes(6).toString('hex')}`;
}

/**
 * Extract a debug zip into a fresh `imported/<id>/` directory and validate it
 * looks like a session bundle. On any failure the partial directory is removed
 * so a bad upload never lingers in the imported list. Returns the bundle's
 * `import-meta.json` contents.
 */
export async function importSessionZip(
  home: string,
  zipBuffer: Buffer,
  originalName: string | null,
  now: Date,
): Promise<ImportInfo> {
  const importId = newImportId();
  const dir = importedDirOf(home, importId);
  await mkdir(dir, { recursive: true });

  try {
    await extractZip(zipBuffer, dir);

    // A debug bundle must contain a main wire; without it there is nothing to
    // visualize. `state.json` / `manifest.json` are best-effort.
    const hasMainWire = await pathExists(join(dir, 'agents', 'main', 'wire.jsonl'));
    if (!hasMainWire) {
      throw new ZipImportError(
        'zip does not look like a kimi-code session bundle (missing agents/main/wire.jsonl)',
      );
    }

    const manifest = await readManifest(dir);
    const meta: ImportInfo = {
      importId,
      importedAt: now.toISOString(),
      originalName: originalName !== null && originalName.length > 0 ? originalName : null,
      manifest,
    };
    await writeFile(join(dir, META_FILE), JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error instanceof ZipImportError ? error : new ZipImportError((error as Error).message);
  }
}

/** Enumerate imported bundle ids (newest-first by directory mtime). */
export async function listImportedIds(home: string): Promise<string[]> {
  const root = importedRootOf(home);
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const ids = entries
    .filter((e) => e.isDirectory() && isImportId(e.name))
    .map((e) => e.name);
  const withMtime = await Promise.all(
    ids.map(async (id) => {
      const mtime = await stat(join(root, id)).then((s) => s.mtimeMs).catch(() => 0);
      return { id, mtime };
    }),
  );
  return withMtime.toSorted((a, b) => b.mtime - a.mtime).map((x) => x.id);
}

export async function readImportMeta(home: string, importId: string): Promise<ImportInfo | null> {
  try {
    const raw = await readFile(join(importedDirOf(home, importId), META_FILE), 'utf8');
    return JSON.parse(raw) as ImportInfo;
  } catch {
    return null;
  }
}

export async function deleteImported(home: string, importId: string): Promise<boolean> {
  if (!isImportId(importId)) return false;
  const dir = importedDirOf(home, importId);
  if (!(await pathExists(dir))) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

async function readManifest(dir: string): Promise<ImportManifest | null> {
  try {
    return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as ImportManifest;
  } catch {
    return null;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
