/**
 * `sessionIndex` domain (L2) — authoritative session-metadata scanning.
 *
 * Reads the persisted session set through the `storage` access-pattern
 * stores, rooted at the `sessionsDir` path layout fact from `bootstrap`. The
 * directory tree `<sessionsDir>/<workspaceId>/<sessionId>/` is the
 * authoritative index: workspace and session ids are enumerated via
 * `IFileSystemStorageService.list`, and each session's metadata document is
 * read via `IAtomicDocumentStore` to build its summary.
 *
 * The session metadata document lives at `<sessionDir>/state.json`, a layout
 * shared by v1 and v2; the `version` field distinguishes them (`2` = v2,
 * epoch-ms timestamps; absent = v1, ISO-string timestamps). The reader also
 * falls back to the legacy `<sessionDir>/session-meta/state.json` path for v2
 * sessions written before the layouts were unified. Both timestamp
 * representations are normalized to epoch ms.
 *
 * These helpers serve the index's authoritative fallback (legacy path), the
 * projector's full scans, and reconciliation — pure functions over injected
 * stores, owning no state themselves.
 */

import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { CHILD_SESSION_KIND, CHILD_SESSION_KIND_KEY, type SessionSummary } from './sessionIndex';

const META_SCOPE = 'session-meta';
const META_KEY = 'state.json';

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

/** The single construction path for summaries — field order is fixed so a
 *  stored summary deep-compares equal to a fresh projection of the same
 *  metadata document. */
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

/** Deep-enough equality for reconciliation: the projection-relevant fields,
 *  with `custom` compared structurally (both sides are JSON-round-tripped
 *  values built by `buildSessionSummary`, so key order is stable). */
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
    return await storage.list(sessionsScope);
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

/** Bounded-concurrency map: resolves every item through `fn`, dropping
 *  `undefined` results, with at most `concurrency` calls in flight. */
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
