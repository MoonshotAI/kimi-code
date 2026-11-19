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
    const meta = JSON.parse(raw) as ImportInfo;
    return { ...meta, manifest: meta.manifest ? sanitizeManifest(meta.manifest) : null };
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
    return sanitizeManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
  } catch {
    return null;
  }
}

const MANIFEST_STRING_FIELDS = [
  'sessionId', 'exportedAt', 'kimiCodeVersion', 'wireProtocolVersion', 'os',
  'nodejsVersion', 'sessionFirstActivity', 'sessionLastActivity', 'title',
  'workspaceDir', 'sessionLogPath', 'globalLogPath', 'desktopLogPath',
  'webLogPath', 'desktopVersion', 'installSource',
] as const;

const SHELL_ENV_STRING_FIELDS = [
  'term',
  'termProgram',
  'termProgramVersion',
  'multiplexer',
  'shell',
] as const;

function sanitizeManifest(raw: unknown): ImportManifest | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const m: Record<string, unknown> = {};
  for (const field of MANIFEST_STRING_FIELDS) {
    if (typeof o[field] === 'string') m[field] = o[field];
  }
  const shellEnv = o['shellEnv'];
  if (typeof shellEnv === 'object' && shellEnv !== null && !Array.isArray(shellEnv)) {
    const source = shellEnv as Record<string, unknown>;
    const sanitized: Record<string, string> = {};
    for (const field of SHELL_ENV_STRING_FIELDS) {
      if (typeof source[field] === 'string') sanitized[field] = source[field];
    }
    m['shellEnv'] = sanitized;
  }
  return m as ImportManifest;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
