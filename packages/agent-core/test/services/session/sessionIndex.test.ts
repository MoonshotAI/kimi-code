import { describe, expect, it } from 'vitest';

import type { SessionSummary } from '../../../src/rpc';
import { SessionIndex, type SessionIndexListOpts, type SessionQueryScope } from '#/session';
import { encodeWorkDirKey } from '../../../src/session/store';

const WORKDIR_A = '/repos/alpha';
const WORKDIR_B = '/repos/beta';
const WORKSPACE_A = encodeWorkDirKey(WORKDIR_A);
const WORKSPACE_B = encodeWorkDirKey(WORKDIR_B);

function makeSummary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    workDir: WORKDIR_A,
    sessionDir: `/sessions/${overrides.id}`,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function seed(index: SessionIndex, summaries: readonly SessionSummary[]): void {
  for (const summary of summaries) {
    index.upsert(summary);
  }
}

const GLOBAL: SessionQueryScope = { kind: 'global' };

function ids(rows: readonly SessionSummary[]): string[] {
  return rows.map((s) => s.id);
}

describe('SessionIndex', () => {
  it('upsert then get returns the summary', () => {
    const index = new SessionIndex();
    const summary = makeSummary({ id: 's1', title: 'one' });
    index.upsert(summary);

    expect(index.get('s1')).toEqual(summary);
  });

  it('upsert replaces an existing row for the same id', () => {
    const index = new SessionIndex();
    index.upsert(makeSummary({ id: 's1', title: 'first', updatedAt: 1 }));
    index.upsert(makeSummary({ id: 's1', title: 'second', updatedAt: 2 }));

    expect(index.get('s1')?.title).toBe('second');
    expect(index.count(GLOBAL)).toBe(1);
  });

  it('remove makes get undefined and excludes the row from list', () => {
    const index = new SessionIndex();
    seed(index, [makeSummary({ id: 's1' }), makeSummary({ id: 's2' })]);

    index.remove('s1');

    expect(index.get('s1')).toBeUndefined();
    expect(ids(index.list(GLOBAL, {}))).toEqual(['s2']);
  });

  it('remove is a no-op for an unknown id', () => {
    const index = new SessionIndex();
    index.upsert(makeSummary({ id: 's1' }));

    expect(() => index.remove('missing')).not.toThrow();
    expect(index.count(GLOBAL)).toBe(1);
  });

  it('global scope returns every non-archived row', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'a', workDir: WORKDIR_A }),
      makeSummary({ id: 'b', workDir: WORKDIR_B }),
      makeSummary({ id: 'c', workDir: WORKDIR_A, archived: true }),
    ]);

    expect(ids(index.list(GLOBAL, {})).sort()).toEqual(['a', 'b']);
  });

  it('workspace scope filters by workspaceId (derived from workDir)', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'a1', workDir: WORKDIR_A }),
      makeSummary({ id: 'a2', workDir: WORKDIR_A }),
      makeSummary({ id: 'b1', workDir: WORKDIR_B }),
    ]);

    const scopeA: SessionQueryScope = { kind: 'workspace', workspaceId: WORKSPACE_A };
    const scopeB: SessionQueryScope = { kind: 'workspace', workspaceId: WORKSPACE_B };

    expect(ids(index.list(scopeA, {})).sort()).toEqual(['a1', 'a2']);
    expect(ids(index.list(scopeB, {}))).toEqual(['b1']);
  });

  it('workDir scope filters by exact workDir', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'a', workDir: WORKDIR_A }),
      makeSummary({ id: 'b', workDir: WORKDIR_B }),
    ]);

    const scope: SessionQueryScope = { kind: 'workDir', workDir: WORKDIR_B };
    expect(ids(index.list(scope, {}))).toEqual(['b']);
  });

  it('children scope filters by parent_session_id + child kind', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({
        id: 'child-1',
        metadata: { parent_session_id: 'parent', child_session_kind: 'child' },
      }),
      makeSummary({
        id: 'child-2',
        metadata: { parent_session_id: 'parent', child_session_kind: 'child' },
      }),
      makeSummary({
        id: 'other-parent',
        metadata: { parent_session_id: 'someone-else', child_session_kind: 'child' },
      }),
      makeSummary({
        id: 'wrong-kind',
        metadata: { parent_session_id: 'parent', child_session_kind: 'fork' },
      }),
      makeSummary({ id: 'no-meta' }),
    ]);

    const scope: SessionQueryScope = { kind: 'children', parentId: 'parent' };
    expect(ids(index.list(scope, {})).sort()).toEqual(['child-1', 'child-2']);
  });

  it('archived visibility: exclude (default) / include / only', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'live' }),
      makeSummary({ id: 'archived', archived: true }),
    ]);

    const exclude: SessionIndexListOpts = { archived: 'exclude' };
    const include: SessionIndexListOpts = { archived: 'include' };
    const only: SessionIndexListOpts = { archived: 'only' };

    expect(ids(index.list(GLOBAL, {}))).toEqual(['live']); // default exclude
    expect(ids(index.list(GLOBAL, exclude))).toEqual(['live']);
    expect(ids(index.list(GLOBAL, include)).sort()).toEqual(['archived', 'live']);
    expect(ids(index.list(GLOBAL, only))).toEqual(['archived']);
  });

  it('orderBy updatedAt desc (default) orders newest first', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'old', updatedAt: 1 }),
      makeSummary({ id: 'new', updatedAt: 3 }),
      makeSummary({ id: 'mid', updatedAt: 2 }),
    ]);

    expect(ids(index.list(GLOBAL, {}))).toEqual(['new', 'mid', 'old']);
  });

  it('orderBy createdAt asc orders oldest first', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'c', createdAt: 300 }),
      makeSummary({ id: 'a', createdAt: 100 }),
      makeSummary({ id: 'b', createdAt: 200 }),
    ]);

    const opts: SessionIndexListOpts = { orderBy: 'createdAt', orderDirection: 'asc' };
    expect(ids(index.list(GLOBAL, opts))).toEqual(['a', 'b', 'c']);
  });

  it('orderBy title desc ties break by id ascending', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'x2', title: 'same' }),
      makeSummary({ id: 'x1', title: 'same' }),
      makeSummary({ id: 'z', title: 'zzz' }),
      makeSummary({ id: 'a', title: 'aaa' }),
    ]);

    const opts: SessionIndexListOpts = { orderBy: 'title', orderDirection: 'desc' };
    // zzz > same > aaa; the two `same` rows tie-break by id (x1 < x2).
    expect(ids(index.list(GLOBAL, opts))).toEqual(['z', 'x1', 'x2', 'a']);
  });

  it('pagination: limit caps the page', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 's1', updatedAt: 1 }),
      makeSummary({ id: 's2', updatedAt: 2 }),
      makeSummary({ id: 's3', updatedAt: 3 }),
    ]);

    const opts: SessionIndexListOpts = { limit: 2 };
    expect(ids(index.list(GLOBAL, opts))).toEqual(['s3', 's2']);
  });

  it('pagination: cursor returns the next page deterministically', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 's1', updatedAt: 1 }),
      makeSummary({ id: 's2', updatedAt: 2 }),
      makeSummary({ id: 's3', updatedAt: 3 }),
      makeSummary({ id: 's4', updatedAt: 4 }),
    ]);

    const first = index.list(GLOBAL, { limit: 2 });
    expect(ids(first)).toEqual(['s4', 's3']);

    const next = index.list(GLOBAL, { cursor: first[first.length - 1]!.id, limit: 2 });
    expect(ids(next)).toEqual(['s2', 's1']);
  });

  it('search matches by title within a scope (case-insensitive)', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'a', workDir: WORKDIR_A, title: 'Fix login bug' }),
      makeSummary({ id: 'b', workDir: WORKDIR_A, title: 'Refactor auth' }),
      makeSummary({ id: 'c', workDir: WORKDIR_B, title: 'fix signup flow' }),
    ]);

    const scopeA: SessionQueryScope = { kind: 'workspace', workspaceId: WORKSPACE_A };
    expect(ids(index.search(scopeA, 'fix', {}))).toEqual(['a']);
    expect(ids(index.search(GLOBAL, 'fix', {})).sort()).toEqual(['a', 'c']);
    expect(index.search(GLOBAL, 'nope', {})).toEqual([]);
  });

  it('count matches list length for a scope (no pagination applied)', () => {
    const index = new SessionIndex();
    seed(index, [
      makeSummary({ id: 'a1', workDir: WORKDIR_A }),
      makeSummary({ id: 'a2', workDir: WORKDIR_A }),
      makeSummary({ id: 'b1', workDir: WORKDIR_B }),
      makeSummary({ id: 'a3', workDir: WORKDIR_A, archived: true }),
    ]);

    const scopeA: SessionQueryScope = { kind: 'workspace', workspaceId: WORKSPACE_A };
    expect(index.count(scopeA)).toBe(2);
    expect(index.count(scopeA)).toBe(index.list(scopeA, {}).length);
    expect(index.count(scopeA, { archived: 'include' })).toBe(3);
    // count ignores limit — it measures the whole scoped set.
    expect(index.count(scopeA, { limit: 1 })).toBe(2);
  });
});
