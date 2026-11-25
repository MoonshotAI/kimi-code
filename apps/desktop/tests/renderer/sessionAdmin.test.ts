import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildSessionAdminIdsQuery,
  buildSessionAdminQuery,
  dayEndMs,
  dayStartMs,
  resetKimiClientDeps,
  setKimiClientDeps,
  useSessionAdmin,
  type SessionAdminFilters,
} from '@moonshot-ai/app-client/client';
import { pageItems } from '@moonshot-ai/app-components/support';
import { sessionListStore, workspacesStore } from '@moonshot-ai/app-client/stores';
import type { AppSession, SessionsPage } from '@moonshot-ai/app-core/api';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
  sessionListStore().resetSessionList();
  workspacesStore().workspaces = [];
});
afterEach(() => {
  resetKimiClientDeps();
});

function row(id: string, archived = false): AppSession {
  return {
    id,
    workspaceId: 'ws1',
    cwd: '/repo/ws1',
    title: `title-${id}`,
    lastPrompt: `prompt-${id}`,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(2000).toISOString(),
    busy: false,
    archived,
    archivedAt: archived ? new Date(3000).toISOString() : undefined,
    model: '',
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      contextTokens: 0,
      contextLimit: 0,
      turnCount: 0,
    },
    messageCount: 0,
  };
}

function page(items: AppSession[], total = items.length): SessionsPage {
  return { items, hasMore: false, nextPageToken: null, total };
}

function filters(partial: Partial<SessionAdminFilters> = {}): SessionAdminFilters {
  return { workspaceIds: [], status: 'all', updatedFrom: '', updatedTo: '', ...partial };
}

function createAdmin() {
  const listSessions = vi.fn().mockResolvedValue(page([row('s1')]));
  getKimiWebApiMock.mockReturnValue({ listSessions });
  const pushOperationFailure = vi.fn();
  const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
  const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
  return { admin, listSessions, pushOperationFailure, applySessionsArchivedLocally };
}

async function tick(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe('session admin query mapping', () => {
  it('maps the default state: archived all, sort desc, no workspace/time conditions', () => {
    expect(buildSessionAdminQuery(filters(), 1, 20)).toEqual({
      workspaceIds: undefined,
      archived: 'all',
      updatedAfter: undefined,
      updatedBefore: undefined,
      sort: 'updated_at_desc',
      page: 1,
      pageSize: 20,
    });
  });

  it('maps the status tri-state: open → archived false, done → true, all → all', () => {
    expect(buildSessionAdminQuery(filters({ status: 'open' }), 1, 20).archived).toBe(false);
    expect(buildSessionAdminQuery(filters({ status: 'done' }), 1, 20).archived).toBe(true);
    expect(buildSessionAdminQuery(filters({ status: 'all' }), 1, 20).archived).toBe('all');
  });

  it('passes workspace ids through (OR semantics), empty = no filter', () => {
    expect(buildSessionAdminQuery(filters({ workspaceIds: [] }), 1, 20).workspaceIds).toBeUndefined();
    const q = buildSessionAdminQuery(filters({ workspaceIds: ['ws1', 'ws2'] }), 1, 20);
    expect(q.workspaceIds).toEqual(['ws1', 'ws2']);
  });

  it('maps the day range to local-day bounds; either end may stay open', () => {
    const both = buildSessionAdminQuery(
      filters({ updatedFrom: '2026-08-01', updatedTo: '2026-08-15' }),
      1,
      20,
    );
    expect(both.updatedAfter).toBe(new Date(dayStartMs('2026-08-01')).toISOString());
    expect(both.updatedBefore).toBe(new Date(dayEndMs('2026-08-15')).toISOString());

    const fromOnly = buildSessionAdminQuery(filters({ updatedFrom: '2026-08-01' }), 1, 20);
    expect(fromOnly.updatedAfter).toBe(new Date(dayStartMs('2026-08-01')).toISOString());
    expect(fromOnly.updatedBefore).toBeUndefined();

    const toOnly = buildSessionAdminQuery(filters({ updatedTo: '2026-08-15' }), 1, 20);
    expect(toOnly.updatedAfter).toBeUndefined();
    expect(toOnly.updatedBefore).toBe(new Date(dayEndMs('2026-08-15')).toISOString());
  });

  it('day bounds are LOCAL calendar days (00:00:00.000 → 23:59:59.999)', () => {
    const start = new Date(dayStartMs('2026-08-15'));
    expect([
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      start.getHours(),
      start.getMinutes(),
      start.getSeconds(),
      start.getMilliseconds(),
    ]).toEqual([2026, 7, 15, 0, 0, 0, 0]);
    const end = new Date(dayEndMs('2026-08-15'));
    expect([
      end.getFullYear(),
      end.getMonth(),
      end.getDate(),
      end.getHours(),
      end.getMinutes(),
      end.getSeconds(),
      end.getMilliseconds(),
    ]).toEqual([2026, 7, 15, 23, 59, 59, 999]);
  });
});

describe('session admin data layer (fetch orchestration)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getKimiWebApiMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ensureSeeded fetches page 1 with defaults, lands items/total, and is one-shot', async () => {
    const { admin, listSessions } = createAdmin();

    admin.ensureSeeded();
    expect(admin.state.loading).toBe(true);
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(listSessions).toHaveBeenLastCalledWith({
      workspaceIds: undefined,      archived: 'all',
      updatedAfter: undefined,
      updatedBefore: undefined,
      sort: 'updated_at_desc',
      page: 1,
      pageSize: 20,
    });
    expect(admin.state.items.map((s) => s.id)).toEqual(['s1']);
    expect(admin.state.total).toBe(1);
    expect(admin.state.loading).toBe(false);

    admin.ensureSeeded();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('lists the projects again when a row belongs to a project the app has not seen', async () => {
    const { admin, listSessions } = createAdmin();
    const listWorkspaces = vi.fn().mockResolvedValue([
      { id: 'wd_admin_seen', root: '/app', name: 'app', kind: 'implicit', additionalDirs: [], sessionCount: 1 },
    ]);
    getKimiWebApiMock.mockReturnValue({ listSessions, listWorkspaces });
    listSessions.mockResolvedValue(page([{ ...row('s1'), workspaceId: 'wd_admin_seen', cwd: '/app-fix' }]));

    admin.ensureSeeded();
    await flush();
    await admin.refresh();
    await flush();

    expect(workspacesStore().workspaces.map((w) => [w.id, w.name, w.root])).toEqual([['wd_admin_seen', 'app', '/app']]);
    expect(listWorkspaces).toHaveBeenCalledOnce();
  });

  it('applyFilters on an unseeded admin doubles as the seed — one fetch, ensureSeeded no-ops', async () => {
    const { admin, listSessions } = createAdmin();

    admin.applyFilters({ workspaceIds: ['ws1'], status: 'all', updatedFrom: '', updatedTo: '' });
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(1);
    expect(admin.state.seeded).toBe(true);

    admin.ensureSeeded();
    await flush();
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it('debounces filter changes: rapid setters collapse into one fetch with the latest params', async () => {
    const { admin, listSessions } = createAdmin();
    admin.ensureSeeded();
    await flush();

    admin.setStatus('done');
    admin.setWorkspaceIds(['ws2']);
    admin.setTimeRange('2026-08-01', '');
    expect(listSessions).toHaveBeenCalledTimes(1);
    await tick();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(listSessions).toHaveBeenLastCalledWith({
      workspaceIds: ['ws2'],
      archived: true,
      updatedAfter: new Date(dayStartMs('2026-08-01')).toISOString(),
      updatedBefore: undefined,
      sort: 'updated_at_desc',
      page: 1,
      pageSize: 20,
    });
  });

  it('resets to page 1 on filter/pageSize changes, keeps it on page navigation', async () => {
    const { admin, listSessions } = createAdmin();
    listSessions.mockResolvedValue(page([row('s1')], 100));
    admin.ensureSeeded();
    await flush();

    admin.setPage(3);
    await tick();
    expect(admin.state.page).toBe(3);
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 }));

    admin.setStatus('open');
    await tick();
    expect(admin.state.page).toBe(1);
    expect(listSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, archived: false }),
    );

    admin.setPage(2);
    await tick();
    expect(admin.state.page).toBe(2);
    admin.setPageSize(50);
    await tick();
    expect(admin.state.page).toBe(1);
    expect(listSessions).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50 }),
    );

    const calls = listSessions.mock.calls.length;
    admin.setPage(1);
    admin.setPageSize(50);
    await tick();
    expect(listSessions).toHaveBeenCalledTimes(calls);
  });

  it('drops stale responses: a slow older request never overwrites a newer one', async () => {
    let resolveOld!: (p: SessionsPage) => void;
    let resolveNew!: (p: SessionsPage) => void;
    const listSessions = vi
      .fn()
      .mockReturnValueOnce(new Promise<SessionsPage>((r) => (resolveOld = r)))
      .mockReturnValueOnce(new Promise<SessionsPage>((r) => (resolveNew = r)));
    getKimiWebApiMock.mockReturnValue({ listSessions });
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally: vi.fn().mockResolvedValue(undefined),
    });

    admin.setStatus('done');
    await tick();
    admin.setStatus('open');
    await tick();

    resolveNew(page([row('new')]));
    await flush();
    expect(admin.state.items.map((s) => s.id)).toEqual(['new']);
    expect(admin.state.loading).toBe(false);

    resolveOld(page([row('old')]));
    await flush();
    expect(admin.state.items.map((s) => s.id)).toEqual(['new']);
  });

  it('clamps the page when the server-side total shrank, then refetches the valid page', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(page([row('s1')], 30))
      .mockResolvedValueOnce(page([], 30))
      .mockResolvedValueOnce(page([], 5))
      .mockResolvedValueOnce(page([row('s2')], 5));
    getKimiWebApiMock.mockReturnValue({ listSessions });
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally: vi.fn().mockResolvedValue(undefined),
    });

    admin.ensureSeeded();
    await flush();
    admin.setPageSize(10);
    await tick();
    admin.setPage(3);
    await tick();
    await flush();
    expect(admin.state.page).toBe(1);
    expect(listSessions).toHaveBeenCalledTimes(4);
    expect(listSessions).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('applyFilters writes the draft at once, resets to page 1, and fires exactly one immediate request', async () => {
    const { admin, listSessions } = createAdmin();
    listSessions.mockResolvedValue(page([row('s1')], 100));
    admin.ensureSeeded();
    await flush();
    admin.setPage(3);
    await tick();
    expect(admin.state.page).toBe(3);
    const callsBefore = listSessions.mock.calls.length;

    admin.applyFilters({
      workspaceIds: ['ws9'],
      status: 'done',
      updatedFrom: '2026-08-01',
      updatedTo: '2026-08-15',
    });
    await flush();

    expect(listSessions.mock.calls.length).toBe(callsBefore + 1);
    expect(listSessions).toHaveBeenLastCalledWith({
      workspaceIds: ['ws9'],
      archived: true,
      updatedAfter: new Date(dayStartMs('2026-08-01')).toISOString(),
      updatedBefore: new Date(dayEndMs('2026-08-15')).toISOString(),
      sort: 'updated_at_desc',
      page: 1,
      pageSize: 20,
    });
    expect(admin.state.page).toBe(1);
    expect(admin.state.filters).toEqual({
      workspaceIds: ['ws9'],
      status: 'done',
      updatedFrom: '2026-08-01',
      updatedTo: '2026-08-15',
    });
  });

  it('reports a failed fetch via pushOperationFailure and keeps the old rows', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(page([row('s1')]))
      .mockRejectedValueOnce(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessions });
    const pushOperationFailure = vi.fn();
    const admin = useSessionAdmin({
      pushOperationFailure,
      applySessionsArchivedLocally: vi.fn().mockResolvedValue(undefined),
    });

    admin.ensureSeeded();
    await flush();
    admin.setPage(2);
    await tick();
    await flush();

    expect(pushOperationFailure).toHaveBeenCalledWith('sessionAdmin', expect.any(Error));
    expect(admin.state.items.map((s) => s.id)).toEqual(['s1']);
    expect(admin.state.loading).toBe(false);
  });
});

describe('admin pager page-number folding', () => {
  it('shows everything when there are at most 7 pages', () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('folds the tail while the current page is near the start', () => {
    expect(pageItems(1, 10)).toEqual([1, 2, 3, 4, 5, '…', 10]);
    expect(pageItems(4, 10)).toEqual([1, 2, 3, 4, 5, '…', 10]);
  });

  it('folds the head while the current page is near the end', () => {
    expect(pageItems(7, 10)).toEqual([1, '…', 6, 7, 8, 9, 10]);
    expect(pageItems(10, 10)).toEqual([1, '…', 6, 7, 8, 9, 10]);
  });

  it('folds both sides around a middle page', () => {
    expect(pageItems(5, 10)).toEqual([1, '…', 4, 5, 6, '…', 10]);
    expect(pageItems(6, 10)).toEqual([1, '…', 5, 6, 7, '…', 10]);
  });
});

describe('session admin selection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getKimiWebApiMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('toggleSelection records the lifecycle and toggles back off; page toggle selects/unselects the whole page', () => {
    const { admin } = createAdmin();

    admin.toggleSelection('s1', false);
    admin.toggleSelection('s2', true);
    expect([...admin.state.selectedIds]).toEqual(['s1', 's2']);
    expect(admin.state.selectedArchivedById.get('s1')).toBe(false);
    expect(admin.state.selectedArchivedById.get('s2')).toBe(true);

    admin.toggleSelection('s1', false);
    expect(admin.state.selectedIds.has('s1')).toBe(false);
    expect(admin.state.selectedArchivedById.has('s1')).toBe(false);

    admin.togglePageSelection([
      { id: 'p1', archived: false },
      { id: 'p2', archived: true },
    ]);
    expect(admin.state.selectedIds.has('p1')).toBe(true);
    expect(admin.state.selectedIds.has('p2')).toBe(true);
    expect(admin.state.selectedIds.has('s2')).toBe(true);
    admin.togglePageSelection([
      { id: 'p1', archived: false },
      { id: 'p2', archived: true },
    ]);
    expect(admin.state.selectedIds.has('p1')).toBe(false);
    expect(admin.state.selectedIds.has('p2')).toBe(false);
    expect(admin.state.selectedIds.has('s2')).toBe(true);
  });

  it('keeps the selection across page/filter changes; setSelection collapses; clear empties', async () => {
    const { admin, listSessions } = createAdmin();
    admin.ensureSeeded();
    await flush();
    listSessions.mockResolvedValue(page([row('s1')], 100));

    admin.toggleSelection('s1', false);
    admin.toggleSelection('s9', true);
    admin.setPage(2);
    await tick();
    expect([...admin.state.selectedIds].sort()).toEqual(['s1', 's9']);

    admin.setStatus('done');
    await tick();
    expect([...admin.state.selectedIds].sort()).toEqual(['s1', 's9']);

    admin.setSelection([{ id: 's7', archived: false }]);
    expect([...admin.state.selectedIds]).toEqual(['s7']);
    expect(admin.state.selectedArchivedById.get('s7')).toBe(false);

    admin.clearSelection();
    expect(admin.state.selectedIds.size).toBe(0);
    expect(admin.state.selectedArchivedById.size).toBe(0);
  });

  it('selectedIdsByArchived splits the open/done subsets driving the batch bar', () => {
    const { admin } = createAdmin();
    admin.toggleSelection('o1', false);
    admin.toggleSelection('o2', false);
    admin.toggleSelection('d1', true);
    expect(admin.selectedIdsByArchived(false)).toEqual(['o1', 'o2']);
    expect(admin.selectedIdsByArchived(true)).toEqual(['d1']);
  });

  it('reconciles recorded lifecycles when fresh rows land', async () => {
    const { admin, listSessions } = createAdmin();
    admin.ensureSeeded();
    await flush();

    admin.toggleSelection('s1', false);
    expect(admin.state.selectedArchivedById.get('s1')).toBe(false);

    listSessions.mockResolvedValue(page([row('s1', true)]));
    admin.setPage(1);
    await admin.refresh();

    expect(admin.state.selectedArchivedById.get('s1')).toBe(true);
  });
});

describe('session admin batch archive/restore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getKimiWebApiMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createBatchAdmin(results: Array<{ id: string; ok: boolean }>) {
    const listSessions = vi.fn().mockResolvedValue(page([row('s1')]));
    const archiveSessions = vi.fn().mockResolvedValue({
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
    const restoreSessions = vi.fn().mockResolvedValue({
      results,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    });
    getKimiWebApiMock.mockReturnValue({ listSessions, archiveSessions, restoreSessions });
    const pushOperationFailure = vi.fn();
    const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
    const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
    return {
      admin,
      listSessions,
      archiveSessions,
      restoreSessions,
      pushOperationFailure,
      applySessionsArchivedLocally,
    };
  }

  it('partial success: ok ids reconcile + leave the selection, failed ids stay; the page re-pulls', async () => {
    const { admin, archiveSessions, applySessionsArchivedLocally, listSessions } =
      createBatchAdmin([
        { id: 's1', ok: true },
        { id: 's2', ok: true },
        { id: 's3', ok: false },
      ]);
    admin.ensureSeeded();
    await flush();
    admin.toggleSelection('s1', false);
    admin.toggleSelection('s2', false);
    admin.toggleSelection('s3', false);
    const fetches = listSessions.mock.calls.length;

    const outcome = await admin.archiveSessions(['s1', 's2', 's3']);

    expect(archiveSessions).toHaveBeenCalledWith(['s1', 's2', 's3']);
    expect(outcome).toEqual({ okIds: ['s1', 's2'], succeeded: 2, failed: 1 });
    expect(applySessionsArchivedLocally).toHaveBeenCalledWith(['s1', 's2'], true);
    expect([...admin.state.selectedIds]).toEqual(['s3']);
    expect(admin.state.selectedArchivedById.has('s1')).toBe(false);
    expect(listSessions.mock.calls.length).toBe(fetches + 1);
  });

  it('all failed: no local reconcile, no re-pull, selection untouched', async () => {
    const { admin, applySessionsArchivedLocally, listSessions } = createBatchAdmin([
      { id: 's1', ok: false },
      { id: 's2', ok: false },
    ]);
    admin.ensureSeeded();
    await flush();
    admin.toggleSelection('s1', false);
    admin.toggleSelection('s2', false);
    const fetches = listSessions.mock.calls.length;

    const outcome = await admin.archiveSessions(['s1', 's2']);

    expect(outcome).toEqual({ okIds: [], succeeded: 0, failed: 2 });
    expect(applySessionsArchivedLocally).not.toHaveBeenCalled();
    expect([...admin.state.selectedIds].sort()).toEqual(['s1', 's2']);
    expect(listSessions.mock.calls.length).toBe(fetches);
  });

  it('endpoint throw: surfaces via pushOperationFailure, outcome counts everything failed', async () => {
    const listSessions = vi.fn().mockResolvedValue(page([row('s1')]));
    const archiveSessions = vi.fn().mockRejectedValue(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessions, archiveSessions });
    const pushOperationFailure = vi.fn();
    const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
    const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
    admin.ensureSeeded();
    await flush();
    admin.toggleSelection('s1', false);

    const outcome = await admin.archiveSessions(['s1']);

    expect(pushOperationFailure).toHaveBeenCalledWith('archiveSessions', expect.any(Error));
    expect(outcome).toEqual({ okIds: [], succeeded: 0, failed: 1 });
    expect(applySessionsArchivedLocally).not.toHaveBeenCalled();
    expect(admin.state.selectedIds.has('s1')).toBe(true);
  });

  it('restore direction: hits the restore endpoint and reconciles with archived=false', async () => {
    const { admin, restoreSessions, applySessionsArchivedLocally } = createBatchAdmin([
      { id: 's1', ok: true },
    ]);
    admin.toggleSelection('s1', true);

    const outcome = await admin.restoreSessions(['s1']);

    expect(restoreSessions).toHaveBeenCalledWith(['s1']);
    expect(applySessionsArchivedLocally).toHaveBeenCalledWith(['s1'], false);
    expect(outcome).toEqual({ okIds: ['s1'], succeeded: 1, failed: 0 });
    expect(admin.state.selectedIds.size).toBe(0);
  });

  it('single-row primary action rides the same batch endpoint (ids of length 1)', async () => {
    const { admin, archiveSessions } = createBatchAdmin([{ id: 's1', ok: true }]);

    await admin.archiveSessions(['s1']);

    expect(archiveSessions).toHaveBeenCalledTimes(1);
    expect(archiveSessions).toHaveBeenCalledWith(['s1']);
  });
});

describe('session admin select-all-matching', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getKimiWebApiMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function createMatchingAdmin() {
    const listSessions = vi.fn().mockResolvedValue(page([row('s1')]));
    const listSessionIds = vi.fn().mockResolvedValue({
      items: [
        { id: 'm1', archived: false },
        { id: 'm2', archived: true },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    getKimiWebApiMock.mockReturnValue({ listSessions, listSessionIds });
    const pushOperationFailure = vi.fn();
    const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
    const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
    return { admin, listSessions, listSessionIds, pushOperationFailure };
  }

  it('maps the same conditions in buildSessionAdminIdsQuery (no paging keys)', async () => {
    expect(
      buildSessionAdminIdsQuery(
        filters({ workspaceIds: ['ws1'], status: 'done', updatedTo: '2026-08-15' }),
      ),
    ).toEqual({
      workspaceIds: ['ws1'],
      archived: true,
      updatedAfter: undefined,
      updatedBefore: new Date(dayEndMs('2026-08-15')).toISOString(),
      sort: 'updated_at_desc',
    });
  });

  it('materializes every matching id with its archived flag and sets allMatching', async () => {
    const { admin, listSessionIds } = createMatchingAdmin();
    admin.ensureSeeded();
    await flush();

    await admin.selectAllMatching();

    expect(listSessionIds).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10000, pageToken: undefined }),
    );
    expect([...admin.state.selectedIds].sort()).toEqual(['m1', 'm2']);
    expect(admin.state.selectedArchivedById.get('m1')).toBe(false);
    expect(admin.state.selectedArchivedById.get('m2')).toBe(true);
    expect(admin.state.allMatching).toBe(true);
    expect(admin.state.materializingAll).toBe(false);
  });

  it('cursor-walks the projection in pages until hasMore is false', async () => {
    const { admin, listSessionIds } = createMatchingAdmin();
    listSessionIds
      .mockResolvedValueOnce({
        items: [{ id: 'm1', archived: false }],
        hasMore: true,
        nextPageToken: 't2',
        total: 3,
      })
      .mockResolvedValueOnce({
        items: [
          { id: 'm2', archived: false },
          { id: 'm3', archived: true },
        ],
        hasMore: false,
        nextPageToken: null,
        total: 3,
      });

    await admin.selectAllMatching();

    expect(listSessionIds).toHaveBeenCalledTimes(2);
    expect(listSessionIds).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageToken: 't2' }),
    );
    expect([...admin.state.selectedIds].sort()).toEqual(['m1', 'm2', 'm3']);
    expect(admin.state.allMatching).toBe(true);
  });

  it('unions with hand-picked rows; exclusions shrink it, emptying drops the mode', async () => {
    const { admin } = createMatchingAdmin();
    admin.toggleSelection('h1', false);
    await admin.selectAllMatching();
    expect([...admin.state.selectedIds].sort()).toEqual(['h1', 'm1', 'm2']);

    admin.toggleSelection('m1', false);
    expect(admin.state.allMatching).toBe(true);
    expect([...admin.state.selectedIds].sort()).toEqual(['h1', 'm2']);

    admin.toggleSelection('h1', false);
    admin.toggleSelection('m2', true);
    expect(admin.state.allMatching).toBe(false);
  });

  it('a fully successful batch empties the selection and exits all-matching mode', async () => {
    const { admin, listSessions, listSessionIds } = createMatchingAdmin();
    const archiveSessions = vi.fn().mockResolvedValue({
      results: [
        { id: 'm1', ok: true },
        { id: 'm2', ok: true },
      ],
      succeeded: 2,
      failed: 0,
    });
    getKimiWebApiMock.mockReturnValue({ listSessions, listSessionIds, archiveSessions });
    admin.ensureSeeded();
    await flush();
    await admin.selectAllMatching();
    expect(admin.state.allMatching).toBe(true);

    await admin.archiveSessions(['m1', 'm2']);

    expect(admin.state.selectedIds.size).toBe(0);
    expect(admin.state.allMatching).toBe(false);
  });

  it('a single-row collapse (right-click adopt) drops the mode', async () => {
    const { admin } = createMatchingAdmin();
    await admin.selectAllMatching();
    admin.setSelection([{ id: 'm1', archived: false }]);
    expect(admin.state.allMatching).toBe(false);
    expect([...admin.state.selectedIds]).toEqual(['m1']);
  });

  it('dies on a real filter change, survives re-applying the same conditions', async () => {
    const { admin, listSessions } = createMatchingAdmin();
    admin.ensureSeeded();
    await flush();
    await admin.selectAllMatching();

    admin.applyFilters({ workspaceIds: [], status: 'all', updatedFrom: '', updatedTo: '' });
    await tick();
    expect(admin.state.allMatching).toBe(true);
    expect(admin.state.selectedIds.size).toBe(2);

    admin.applyFilters({ workspaceIds: [], status: 'done', updatedFrom: '', updatedTo: '' });
    await tick();
    expect(admin.state.allMatching).toBe(false);
    expect(admin.state.selectedIds.size).toBe(0);
    expect(listSessions).toHaveBeenCalled();
  });

  it('discards the materialization when the filters move mid-flight', async () => {
    const { admin } = createMatchingAdmin();
    admin.ensureSeeded();
    await flush();
    let resolveIds: ((page: unknown) => void) | undefined;
    const { listSessionIds } = { listSessionIds: vi.fn() };
    void listSessionIds;
    const hanging = new Promise((r) => {
      resolveIds = r;
    });
    getKimiWebApiMock.mockReturnValue({
      listSessions: vi.fn().mockResolvedValue(page([row('s1')])),
      listSessionIds: vi.fn().mockReturnValue(hanging),
    });

    const pending = admin.selectAllMatching();
    admin.applyFilters({ workspaceIds: ['wsX'], status: 'open', updatedFrom: '', updatedTo: '' });
    resolveIds?.({
      items: [{ id: 'stale', archived: false }],
      hasMore: false,
      nextPageToken: null,
      total: 1,
    });
    await pending;

    expect(admin.state.selectedIds.has('stale')).toBe(false);
    expect(admin.state.allMatching).toBe(false);
    expect(admin.state.materializingAll).toBe(false);
  });
});

describe('session admin batch chunking (>5000 ids)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    getKimiWebApiMock.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function idsOf(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `id${i}`);
  }
  function okResults(ids: string[]) {
    return {
      results: ids.map((id) => ({ id, ok: true })),
      succeeded: ids.length,
      failed: 0,
    };
  }

  it('splits at the 5000-id wire ceiling and merges the outcome', async () => {
    const listSessions = vi.fn().mockResolvedValue(page([row('s1')]));
    const archiveSessions = vi
      .fn()
      .mockImplementation((ids: string[]) => Promise.resolve(okResults(ids)));
    getKimiWebApiMock.mockReturnValue({ listSessions, archiveSessions });
    const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally,
    });

    const outcome = await admin.archiveSessions(idsOf(6000));

    expect(archiveSessions).toHaveBeenCalledTimes(2);
    expect(archiveSessions.mock.calls[0]?.[0]).toHaveLength(5000);
    expect(archiveSessions.mock.calls[1]?.[0]).toHaveLength(1000);
    expect(outcome.succeeded).toBe(6000);
    expect(outcome.failed).toBe(0);
    expect(outcome.okIds).toHaveLength(6000);
    expect(applySessionsArchivedLocally).toHaveBeenCalledTimes(1);
    expect(applySessionsArchivedLocally.mock.calls[0]?.[0]).toHaveLength(6000);
  });

  it('a thrown chunk aborts the rest; everything unexecuted counts as failed', async () => {
    const listSessions = vi.fn().mockResolvedValue(page([row('s1')]));
    const archiveSessions = vi.fn().mockRejectedValue(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessions, archiveSessions });
    const pushOperationFailure = vi.fn();
    const admin = useSessionAdmin({
      pushOperationFailure,
      applySessionsArchivedLocally: vi.fn(),
    });

    const outcome = await admin.archiveSessions(idsOf(6000));

    expect(archiveSessions).toHaveBeenCalledTimes(1);
    expect(pushOperationFailure).toHaveBeenCalledWith('archiveSessions', expect.any(Error));
    expect(outcome).toEqual({ okIds: [], succeeded: 0, failed: 6000 });
  });
});

describe('admin batch toast plan', () => {
  it('plans a toast only when something succeeded; undo inverts the direction', async () => {
    const { planAdminBatchToast, undoBatchDirectionOf } = await import(
      '@moonshot-ai/app-components/support'
    );

    expect(
      planAdminBatchToast('archive', { okIds: ['a', 'b'], succeeded: 2, failed: 0 }),
    ).toEqual({ direction: 'archive', ids: ['a', 'b'], succeeded: 2, failed: 0 });
    expect(
      planAdminBatchToast('restore', { okIds: ['a'], succeeded: 1, failed: 2 }),
    ).toEqual({ direction: 'restore', ids: ['a'], succeeded: 1, failed: 2 });
    expect(planAdminBatchToast('archive', { okIds: [], succeeded: 0, failed: 3 })).toBeNull();

    expect(undoBatchDirectionOf('archive')).toBe('restore');
    expect(undoBatchDirectionOf('restore')).toBe('archive');
  });
});

describe('dropSession', () => {
  it('removes the row, clears its selection, and suppresses an in-flight stale write', async () => {
    let resolveFirst!: (p: SessionsPage) => void;
    const listSessions = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<SessionsPage>((resolve) => { resolveFirst = resolve; }),
      )
      .mockResolvedValue(page([row('s2')]));
    getKimiWebApiMock.mockReturnValue({ listSessions });
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally: vi.fn(),
    });
    admin.state.items = [row('s1')];
    admin.state.selectedIds = new Set(['s1']);
    admin.state.selectedArchivedById = new Map([['s1', false]]);
    admin.state.allMatching = true;

    const first = admin.refresh();
    expect(admin.state.loading).toBe(true);

    admin.dropSession('s1');

    expect(admin.state.loading).toBe(false);
    expect(admin.state.items).toEqual([]);
    expect(admin.state.selectedIds.size).toBe(0);
    expect(admin.state.selectedArchivedById.size).toBe(0);
    expect(admin.state.allMatching).toBe(false);

    resolveFirst(page([row('s1'), row('s2')]));
    await first;
    expect(admin.state.items).toEqual([]);
  });
});

describe('dropSession pagination and materialization interplay', () => {
  it('refetches the current page after a seeded drop so totals stay correct', async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce(page([row('s1'), row('s2')], 2))
      .mockResolvedValueOnce(page([row('s2')], 1));
    getKimiWebApiMock.mockReturnValue({ listSessions });
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally: vi.fn(),
    });
    admin.state.seeded = true;
    await admin.refresh();
    expect(admin.state.total).toBe(2);

    admin.dropSession('s1');
    await flush();

    expect(listSessions).toHaveBeenCalledTimes(2);
    expect(admin.state.items.map((s) => s.id)).toEqual(['s2']);
    expect(admin.state.total).toBe(1);
  });

  it('invalidates an in-flight select-all materialization on drop', async () => {
    let resolveIds!: (p: { items: Array<{ id: string; archived: boolean }>; hasMore: boolean; nextPageToken: string | null }) => void;
    const listSessionIds = vi.fn().mockImplementation(
      () => new Promise((resolve) => { resolveIds = resolve; }),
    );
    const listSessions = vi.fn().mockResolvedValue(page([row('s2')], 1));
    getKimiWebApiMock.mockReturnValue({ listSessionIds, listSessions });
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally: vi.fn(),
    });

    const pending = admin.selectAllMatching();
    await flush();
    admin.dropSession('s1');
    resolveIds({ items: [{ id: 's1', archived: false }, { id: 's2', archived: false }], hasMore: false, nextPageToken: null });
    await pending;

    expect(admin.state.selectedIds.size).toBe(0);
    expect(admin.state.allMatching).toBe(false);
  });
});
