import type Database from 'better-sqlite3';

import { toSummaryRow, type RawSummaryRow, type SessionSummaryRow } from './schema';

export type SessionIndexSort = 'updated_at_desc' | 'updated_at_asc' | 'created_at_desc';

export type SessionIndexArchivedFilter = 'true' | 'false' | 'all';

export interface SessionIndexQuery {
  readonly workspaceIds?: readonly string[];
  readonly archived?: SessionIndexArchivedFilter;
  readonly updatedAfter?: number;
  readonly updatedBefore?: number;
  readonly hasPrompt?: boolean;
  readonly sort?: SessionIndexSort;
  readonly pageSize?: number;
  readonly page?: number;
  readonly pageToken?: string;
}

export type SessionIndexFilterQuery = Omit<SessionIndexQuery, 'pageSize' | 'page' | 'pageToken'>;

export interface SessionIndexGroupQuery extends SessionIndexQuery {
  readonly groupPageSize?: number;
}

export interface SessionSummaryPage {
  readonly items: readonly SessionSummaryRow[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextPageToken: string | null;
}

export interface SessionWorkspaceGroup {
  readonly workspaceId: string | null;
  readonly sessions: readonly SessionSummaryRow[];
  readonly total: number;
}

export interface SessionGroupPage {
  readonly groups: readonly SessionWorkspaceGroup[];
  readonly total: number;
  readonly hasMore: boolean;
  readonly nextPageToken: string | null;
}

export class SessionIndexQueryError extends Error {
  readonly reason: 'invalid-cursor' | 'conflicting-pagination';

  constructor(reason: 'invalid-cursor' | 'conflicting-pagination', message: string) {
    super(message);
    this.name = 'SessionIndexQueryError';
    this.reason = reason;
  }
}

export const DEFAULT_PAGE_SIZE = 50;

export const DEFAULT_GROUP_PAGE_SIZE = 5;

const CURSOR_VERSION = 1;

interface SortSpec {
  readonly keyExpr: string;
  readonly ascending: boolean;
}

interface Where {
  readonly sql: string;
  readonly params: readonly unknown[];
}

interface RankedRow extends RawSummaryRow {
  readonly group_key: string;
}

interface RepRow {
  readonly group_key: string;
  readonly sort_key: number;
  readonly group_total: number;
}

export function listAllSummaries(
  db: Database.Database,
  query: SessionIndexFilterQuery = {},
): readonly SessionSummaryRow[] {
  const sort = sortSpecOf(query.sort ?? 'updated_at_desc');
  const dir = sort.ascending ? 'ASC' : 'DESC';
  const where = filterWhere(query);
  const rows = db
    .prepare<unknown[], RawSummaryRow>(
      `SELECT * FROM session_summary ${where.sql} ORDER BY ${sort.keyExpr} ${dir}, id ${dir}`,
    )
    .all(...where.params);
  return rows.map(toSummaryRow);
}

export function listSummaries(db: Database.Database, query: SessionIndexQuery = {}): SessionSummaryPage {
  assertPagination(query);
  const sort = sortSpecOf(query.sort ?? 'updated_at_desc');
  const dir = sort.ascending ? 'ASC' : 'DESC';
  const where = filterWhere(query);
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const total = countWhere(db, where);
  if (query.page !== undefined) {
    const offset = (Math.max(query.page, 1) - 1) * pageSize;
    const rows = db
      .prepare<unknown[], RawSummaryRow>(
        `SELECT * FROM session_summary ${where.sql} ORDER BY ${sort.keyExpr} ${dir}, id ${dir} LIMIT ? OFFSET ?`,
      )
      .all(...where.params, pageSize, offset);
    return {
      items: rows.map(toSummaryRow),
      total,
      hasMore: offset + rows.length < total,
      nextPageToken: null,
    };
  }
  const conditions: string[] = [];
  const params: unknown[] = [...where.params];
  if (query.pageToken !== undefined) {
    const [key, id] = decodeCursor(query.pageToken);
    const comparison = sort.ascending ? '>' : '<';
    conditions.push(`(${sort.keyExpr} ${comparison} ? OR (${sort.keyExpr} = ? AND id ${comparison} ?))`);
    params.push(key, key, id);
  }
  const cursorSql = conditions.length === 0 ? '' : `${where.sql === '' ? 'WHERE' : 'AND'} ${conditions.join(' AND ')}`;
  const rows = db
    .prepare<unknown[], RawSummaryRow>(
      `SELECT * FROM session_summary ${where.sql} ${cursorSql} ORDER BY ${sort.keyExpr} ${dir}, id ${dir} LIMIT ?`,
    )
    .all(...params, pageSize + 1);
  const hasMore = rows.length > pageSize;
  const items = (hasMore ? rows.slice(0, pageSize) : rows).map(toSummaryRow);
  const last = items.at(-1);
  return {
    items,
    total,
    hasMore,
    nextPageToken:
      hasMore && last !== undefined
        ? encodeCursor(sortKeyOf(last, query.sort ?? 'updated_at_desc'), last.id)
        : null,
  };
}

export function listWorkspaceGroups(
  db: Database.Database,
  query: SessionIndexGroupQuery = {},
): SessionGroupPage {
  assertPagination(query);
  const sort = sortSpecOf(query.sort ?? 'updated_at_desc');
  const dir = sort.ascending ? 'ASC' : 'DESC';
  const where = filterWhere(query);
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
  const groupPageSize = query.groupPageSize ?? DEFAULT_GROUP_PAGE_SIZE;
  const cte = `
    WITH filtered AS (
      SELECT *, COALESCE(workspace_id, '') AS group_key, ${sort.keyExpr} AS sort_key
      FROM session_summary ${where.sql}
    ),
    ranked AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY sort_key ${dir}, id ${dir}) AS rn,
        COUNT(*) OVER (PARTITION BY group_key) AS group_total
      FROM filtered
    )
  `;
  const total =
    db
      .prepare<unknown[], { count: number }>(`${cte} SELECT COUNT(*) AS count FROM ranked WHERE rn = 1`)
      .get(...where.params)?.count ?? 0;

  const conditions: string[] = [];
  const params: unknown[] = [...where.params];
  if (query.pageToken !== undefined) {
    const [key, id] = decodeCursor(query.pageToken);
    const comparison = sort.ascending ? '>' : '<';
    conditions.push(`AND (sort_key ${comparison} ? OR (sort_key = ? AND group_key > ?))`);
    params.push(key, key, id);
  }
  const limit = query.page !== undefined ? pageSize : pageSize + 1;
  const offset = query.page !== undefined ? (Math.max(query.page, 1) - 1) * pageSize : 0;
  const reps = db
    .prepare<unknown[], RepRow>(
      `${cte} SELECT group_key, sort_key, group_total FROM ranked WHERE rn = 1 ${conditions.join(' ')}
       ORDER BY sort_key ${dir}, group_key ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset);
  const hasMore = query.page !== undefined ? offset + reps.length < total : reps.length > pageSize;
  const pageReps = query.page !== undefined || !hasMore ? reps : reps.slice(0, pageSize);

  const itemsByGroup = new Map<string, SessionSummaryRow[]>();
  const keys = pageReps.map((rep) => rep.group_key);
  if (keys.length > 0) {
    const rows = db
      .prepare<unknown[], RankedRow>(
        `${cte} SELECT * FROM ranked WHERE rn <= ? AND group_key IN (${keys.map(() => '?').join(', ')})
         ORDER BY group_key ASC, rn ASC`,
      )
      .all(...where.params, groupPageSize, ...keys);
    for (const row of rows) {
      const group = itemsByGroup.get(row.group_key) ?? [];
      group.push(toSummaryRow(row));
      itemsByGroup.set(row.group_key, group);
    }
  }

  const lastRep = pageReps.at(-1);
  return {
    groups: pageReps.map((rep) => ({
      workspaceId: rep.group_key === '' ? null : rep.group_key,
      sessions: itemsByGroup.get(rep.group_key) ?? [],
      total: rep.group_total,
    })),
    total,
    hasMore,
    nextPageToken:
      query.page === undefined && hasMore && lastRep !== undefined
        ? encodeCursor(lastRep.sort_key, lastRep.group_key)
        : null,
  };
}

function assertPagination(query: SessionIndexQuery): void {
  if (query.page !== undefined && query.pageToken !== undefined) {
    throw new SessionIndexQueryError(
      'conflicting-pagination',
      'page and pageToken are mutually exclusive',
    );
  }
}

function sortSpecOf(sort: SessionIndexSort): SortSpec {
  if (sort === 'created_at_desc') return { keyExpr: 'COALESCE(created_at, 0)', ascending: false };
  if (sort === 'updated_at_asc') return { keyExpr: 'COALESCE(updated_at, 0)', ascending: true };
  return { keyExpr: 'COALESCE(updated_at, 0)', ascending: false };
}

function sortKeyOf(row: SessionSummaryRow, sort: SessionIndexSort): number {
  return sort === 'created_at_desc' ? row.createdAt : row.updatedAt;
}

function filterWhere(query: SessionIndexQuery): Where {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const workspaceIds = query.workspaceIds?.filter((id) => id.length > 0) ?? [];
  if (workspaceIds.length > 0) {
    conditions.push(`workspace_id IN (${workspaceIds.map(() => '?').join(', ')})`);
    params.push(...workspaceIds);
  }
  const archived = query.archived ?? 'false';
  if (archived === 'false') conditions.push('archived = 0');
  if (archived === 'true') conditions.push('archived = 1');
  if (query.updatedAfter !== undefined) {
    conditions.push('COALESCE(updated_at, 0) >= ?');
    params.push(Math.floor(query.updatedAfter));
  }
  if (query.updatedBefore !== undefined) {
    conditions.push('COALESCE(updated_at, 0) <= ?');
    params.push(Math.floor(query.updatedBefore));
  }
  if (query.hasPrompt !== undefined) {
    conditions.push(
      query.hasPrompt
        ? "(last_prompt IS NOT NULL AND last_prompt != '')"
        : "(last_prompt IS NULL OR last_prompt = '')",
    );
  }
  return { sql: conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`, params };
}

function countWhere(db: Database.Database, where: Where): number {
  const row = db
    .prepare<unknown[], { count: number }>(`SELECT COUNT(*) AS count FROM session_summary ${where.sql}`)
    .get(...where.params);
  return row?.count ?? 0;
}

function encodeCursor(key: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: CURSOR_VERSION, k: [key, id] })).toString('base64url');
}

function decodeCursor(raw: string): readonly [number, string] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new SessionIndexQueryError('invalid-cursor', 'page token is corrupted');
  }
  const token = parsed as { v?: unknown; k?: unknown };
  const key = Array.isArray(token.k) ? token.k : undefined;
  if (
    token.v !== CURSOR_VERSION ||
    key === undefined ||
    key.length !== 2 ||
    typeof key[0] !== 'number' ||
    typeof key[1] !== 'string'
  ) {
    throw new SessionIndexQueryError('invalid-cursor', 'page token is malformed');
  }
  return [key[0], key[1]];
}
