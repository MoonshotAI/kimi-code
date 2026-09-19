import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { CHILD_SESSION_KIND, CHILD_SESSION_KIND_KEY, type SessionSummary } from './sessionIndex';
import { SESSION_INDEX_DIRTY_DIR } from './sessionIndexDirtyJournal';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';

export const SESSION_INDEX_SCAN_CACHE_DIR = '.index-cache';

const SCAN_CACHE_KEY = 'scan.json';
const SCAN_CACHE_VERSION = 1;

export interface SessionScanCacheEntry {
  readonly ws: string;
  readonly meta: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly summary: SessionSummary;
}

interface SessionScanCacheFile {
  readonly version: number;
  readonly sessions: Record<string, SessionScanCacheEntry>;
}

export interface SessionStateFileStat {
  readonly meta: string;
  readonly mtimeMs: number;
  readonly size: number;
}

function scanCacheScope(sessionsScope: string): string {
  return `${sessionsScope}/${SESSION_INDEX_SCAN_CACHE_DIR}`;
}

function isScanCacheEntryShape(value: unknown): value is SessionScanCacheEntry {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Record<string, unknown>;
  const summary = entry['summary'];
  return (
    typeof entry['ws'] === 'string' &&
    typeof entry['meta'] === 'string' &&
    typeof entry['mtimeMs'] === 'number' &&
    Number.isFinite(entry['mtimeMs']) &&
    typeof entry['size'] === 'number' &&
    Number.isFinite(entry['size']) &&
    summary !== null &&
    typeof summary === 'object' &&
    typeof (summary as Record<string, unknown>)['id'] === 'string' &&
    typeof (summary as Record<string, unknown>)['workspaceId'] === 'string' &&
    typeof (summary as Record<string, unknown>)['createdAt'] === 'number' &&
    typeof (summary as Record<string, unknown>)['updatedAt'] === 'number' &&
    typeof (summary as Record<string, unknown>)['archived'] === 'boolean'
  );
}

export async function readSessionScanCache(
  storage: IFileSystemStorageService,
  sessionsScope: string,
): Promise<Map<string, SessionScanCacheEntry>> {
  const out = new Map<string, SessionScanCacheEntry>();
  try {
    const bytes = await storage.read(scanCacheScope(sessionsScope), SCAN_CACHE_KEY);
    if (bytes === undefined) return out;
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as SessionScanCacheFile;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.version !== SCAN_CACHE_VERSION ||
      parsed.sessions === null ||
      typeof parsed.sessions !== 'object'
    ) {
      return out;
    }
    for (const [id, entry] of Object.entries(parsed.sessions)) {
      if (isScanCacheEntryShape(entry)) out.set(id, entry);
    }
  } catch {
    out.clear();
  }
  return out;
}

export async function writeSessionScanCache(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  entries: ReadonlyMap<string, SessionScanCacheEntry>,
): Promise<void> {
  const file: SessionScanCacheFile = {
    version: SCAN_CACHE_VERSION,
    sessions: Object.fromEntries(entries),
  };
  await storage.write(
    scanCacheScope(sessionsScope),
    SCAN_CACHE_KEY,
    new TextEncoder().encode(JSON.stringify(file)),
  );
}

export async function statSessionStateFile(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
): Promise<SessionStateFileStat | undefined> {
  for (const meta of [META_KEY, `${META_SCOPE}/${META_KEY}`]) {
    const scope =
      meta === META_KEY
        ? `${sessionsScope}/${workspaceId}/${sessionId}`
        : `${sessionsScope}/${workspaceId}/${sessionId}/${META_SCOPE}`;
    try {
      const [mtimeMs, size] = await Promise.all([
        storage.mtime(scope, META_KEY),
        storage.size(scope, META_KEY),
      ]);
      if (mtimeMs === undefined || size === undefined) continue;
      return { meta, mtimeMs, size };
    } catch {
      continue;
    }
  }
  return undefined;
}

export function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function parseTurnOutcome(value: unknown): 'completed' | 'cancelled' | 'failed' | undefined {
  return value === 'completed' || value === 'cancelled' || value === 'failed' ? value : undefined;
}

export function recoverCwd(meta: Record<string, unknown>): string | undefined {
  if (typeof meta['cwd'] === 'string' && meta['cwd'].length > 0) return meta['cwd'];
  if (typeof meta['workDir'] === 'string' && meta['workDir'].length > 0) {
    return meta['workDir'];
  }
  const custom = meta['custom'];
  if (custom !== null && typeof custom === 'object' && !Array.isArray(custom)) {
    const fromCustom = (custom as Record<string, unknown>)['cwd'];
    if (typeof fromCustom === 'string' && fromCustom.length > 0) return fromCustom;
  }
  return undefined;
}

export function buildSessionSummary(fields: {
  id: string;
  workspaceId: string;
  cwd?: string;
  title?: string;
  lastPrompt?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  archivedAt?: number;
  custom?: Record<string, unknown>;
  lastTurnReason?: 'completed' | 'cancelled' | 'failed';
}): SessionSummary {
  return {
    id: fields.id,
    workspaceId: fields.workspaceId,
    cwd: fields.cwd,
    title: fields.title,
    lastPrompt: fields.lastPrompt,
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt,
    archived: fields.archived,
    archivedAt: fields.archivedAt,
    custom: fields.custom,
    lastTurnReason: fields.lastTurnReason,
  };
}

export function summaryMatchesChildOf(
  summary: SessionSummary,
  parentId: string | undefined,
): boolean {
  if (parentId === undefined) return true;
  const custom = summary.custom;
  return (
    custom?.['parent_session_id'] === parentId &&
    custom?.[CHILD_SESSION_KIND_KEY] === CHILD_SESSION_KIND
  );
}

export function summaryEquals(a: SessionSummary, b: SessionSummary): boolean {
  return (
    a.id === b.id &&
    a.workspaceId === b.workspaceId &&
    a.cwd === b.cwd &&
    a.title === b.title &&
    a.lastPrompt === b.lastPrompt &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.archived === b.archived &&
    a.archivedAt === b.archivedAt &&
    a.lastTurnReason === b.lastTurnReason &&
    JSON.stringify(a.custom) === JSON.stringify(b.custom)
  );
}

export async function listWorkspaceIds(
  storage: IFileSystemStorageService,
  sessionsScope: string,
): Promise<readonly string[]> {
  try {
    return (await storage.list(sessionsScope)).filter(
      (entry) => entry !== SESSION_INDEX_DIRTY_DIR && entry !== SESSION_INDEX_SCAN_CACHE_DIR,
    );
  } catch {
    return [];
  }
}

export async function listSessionIds(
  storage: IFileSystemStorageService,
  sessionsScope: string,
  workspaceId: string,
): Promise<readonly string[]> {
  try {
    return await storage.list(`${sessionsScope}/${workspaceId}`);
  } catch {
    return [];
  }
}

export async function readSessionSummary(
  docs: IAtomicDocumentStore,
  sessionsScope: string,
  workspaceId: string,
  sessionId: string,
): Promise<SessionSummary | undefined> {
  const base = `${sessionsScope}/${workspaceId}/${sessionId}`;
  const meta = (await readMeta(docs, base)) ?? (await readMeta(docs, `${base}/${META_SCOPE}`));
  if (meta === undefined) return undefined;
  const rawCustom = meta['custom'];
  const custom =
    rawCustom !== null && typeof rawCustom === 'object' && !Array.isArray(rawCustom)
      ? (rawCustom as Record<string, unknown>)
      : undefined;
  return buildSessionSummary({
    id: sessionId,
    workspaceId,
    cwd: recoverCwd(meta),
    title: typeof meta['title'] === 'string' ? meta['title'] : undefined,
    lastPrompt: typeof meta['lastPrompt'] === 'string' ? meta['lastPrompt'] : undefined,
    createdAt: parseTime(meta['createdAt']),
    updatedAt: parseTime(meta['updatedAt']),
    archived: meta['archived'] === true,
    archivedAt: meta['archivedAt'] === undefined ? undefined : parseTime(meta['archivedAt']),
    custom,
    lastTurnReason: parseTurnOutcome(meta['lastTurnReason']),
  });
}

async function readMeta(
  docs: IAtomicDocumentStore,
  scope: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return await docs.get<Record<string, unknown>>(scope, META_KEY);
  } catch {
    return undefined;
  }
}

export async function mapBounded<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R | undefined>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      const value = await fn(item);
      if (value !== undefined) out.push(value);
    }
  });
  await Promise.all(workers);
  return out;
}
