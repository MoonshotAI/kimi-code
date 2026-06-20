import type { SessionSummary } from '../../rpc';
import { encodeWorkDirKey } from '../../session/store';
import type {
  ISessionIndex,
  SessionIndexArchiveVisibility,
  SessionIndexListOpts,
  SessionIndexOrderBy,
  SessionIndexOrderDirection,
  SessionQueryScope,
} from './session';

/**
 * Mirrors `CHILD_SESSION_KIND` in `sessionService.ts`. A child session is
 * identified by `metadata.parent_session_id` + this kind tag; the index
 * uses the same derivation so the `children` scope lines up with
 * `SessionService.listChildren` once M1.3 routes through it.
 */
const CHILD_SESSION_KIND = 'child';

/**
 * In-memory read-model index over `SessionSummary` rows.
 *
 * Owns the single implementation of archive visibility, ordering, and
 * pagination for session list / count / search. It is a plain class (not
 * a `*Service` DI singleton); the upcoming `SessionQueryService` facade
 * (M1.3) will construct, populate, and consume it.
 */
export class SessionIndex implements ISessionIndex {
  private readonly summaries = new Map<string, SessionSummary>();

  upsert(summary: SessionSummary): void {
    this.summaries.set(summary.id, summary);
  }

  remove(id: string): void {
    this.summaries.delete(id);
  }

  get(id: string): SessionSummary | undefined {
    return this.summaries.get(id);
  }

  list(scope: SessionQueryScope, opts: SessionIndexListOpts): SessionSummary[] {
    const rows = this.collect(scope, opts);
    return applyPagination(rows, opts.cursor, opts.limit);
  }

  count(scope: SessionQueryScope, opts?: SessionIndexListOpts): number {
    const visibility = opts?.archived ?? 'exclude';
    let total = 0;
    for (const summary of this.summaries.values()) {
      if (!inScope(summary, scope)) continue;
      if (!matchesArchive(summary, visibility)) continue;
      total += 1;
    }
    return total;
  }

  search(
    scope: SessionQueryScope,
    query: string,
    opts?: SessionIndexListOpts,
  ): SessionSummary[] {
    const needle = query.toLowerCase();
    const rows = this.collect(scope, opts, (summary) =>
      (summary.title ?? '').toLowerCase().includes(needle),
    );
    return applyPagination(rows, opts?.cursor, opts?.limit);
  }

  /**
   * Shared scope + visibility (+ optional search predicate) filter and the
   * single sort site. Pagination is layered on by the callers that need it
   * (`list` / `search`); `count` skips this helper to avoid sorting rows it
   * only measures.
   */
  private collect(
    scope: SessionQueryScope,
    opts: SessionIndexListOpts | undefined,
    predicate?: (summary: SessionSummary) => boolean,
  ): SessionSummary[] {
    const visibility = opts?.archived ?? 'exclude';
    const orderBy = opts?.orderBy ?? 'updatedAt';
    const direction = opts?.orderDirection ?? 'desc';
    const rows: SessionSummary[] = [];
    for (const summary of this.summaries.values()) {
      if (!inScope(summary, scope)) continue;
      if (!matchesArchive(summary, visibility)) continue;
      if (predicate !== undefined && !predicate(summary)) continue;
      rows.push(summary);
    }
    rows.sort((a, b) => compareSummaries(a, b, orderBy, direction));
    return rows;
  }
}

function inScope(summary: SessionSummary, scope: SessionQueryScope): boolean {
  switch (scope.kind) {
    case 'global':
      return true;
    case 'workspace':
      // The workspace id is derived from `workDir` (see
      // `toProtocolSession`); it is not stored on the summary itself.
      return encodeWorkDirKey(summary.workDir) === scope.workspaceId;
    case 'workDir':
      return summary.workDir === scope.workDir;
    case 'children': {
      const meta = summary.metadata;
      return (
        meta?.['parent_session_id'] === scope.parentId &&
        meta?.['child_session_kind'] === CHILD_SESSION_KIND
      );
    }
  }
}

function matchesArchive(
  summary: SessionSummary,
  visibility: SessionIndexArchiveVisibility,
): boolean {
  const archived = summary.archived === true;
  switch (visibility) {
    case 'exclude':
      return !archived;
    case 'include':
      return true;
    case 'only':
      return archived;
  }
}

function compareSummaries(
  a: SessionSummary,
  b: SessionSummary,
  orderBy: SessionIndexOrderBy,
  direction: SessionIndexOrderDirection,
): number {
  let cmp: number;
  switch (orderBy) {
    case 'updatedAt':
      cmp = a.updatedAt - b.updatedAt;
      break;
    case 'createdAt':
      cmp = a.createdAt - b.createdAt;
      break;
    case 'title':
      cmp = (a.title ?? '').localeCompare(b.title ?? '');
      break;
  }
  if (direction === 'desc') {
    cmp = -cmp;
  }
  if (cmp !== 0) {
    return cmp;
  }
  // Deterministic tie-break so equal keys still produce a stable order.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function applyPagination(
  rows: readonly SessionSummary[],
  cursor: string | undefined,
  limit: number | undefined,
): SessionSummary[] {
  let start = 0;
  if (cursor !== undefined) {
    const idx = rows.findIndex((s) => s.id === cursor);
    // Cursor miss falls through to the full list, mirroring the pivot-miss
    // behavior of `SessionService.list` / `listChildren`.
    if (idx >= 0) {
      start = idx + 1;
    }
  }
  const afterCursor = rows.slice(start);
  if (limit === undefined) {
    return afterCursor;
  }
  const size = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  return afterCursor.slice(0, size);
}
