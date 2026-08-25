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
import type { V2Session, V2SessionsPage } from '@moonshot-ai/app-core/api';

const getKimiWebApiMock = vi.fn();

beforeEach(() => {
  getKimiWebApiMock.mockReset();
  setKimiClientDeps({ api: () => getKimiWebApiMock(), t: (key) => key });
});
afterEach(() => {
  resetKimiClientDeps();
});

function v2(id: string, archived = false): V2Session {
  return {
    id,
    workspace: { id: 'ws1', cwd: '/repo/ws1' },
    meta: {
      title: `title-${id}`,
      last_prompt: `prompt-${id}`,
      created_at: 1,
      updated_at: 2000,
      archived,
      archived_at: archived ? 3000 : null,
    },
    activity: { status: 'idle' },
  };
}

function page(items: V2Session[], total = items.length): V2SessionsPage {
  return { items, hasMore: false, nextPageToken: null, total };
}

function filters(partial: Partial<SessionAdminFilters> = {}): SessionAdminFilters {
  return { workspaceIds: [], status: 'all', updatedFrom: '', updatedTo: '', ...partial };
}

function createAdmin() {
  const listSessionsV2 = vi.fn().mockResolvedValue(page([v2('s1')]));
  getKimiWebApiMock.mockReturnValue({ listSessionsV2 });
  const pushOperationFailure = vi.fn();
  const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
  const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
  return { admin, listSessionsV2, pushOperationFailure, applySessionsArchivedLocally };
}

/** Fire the debounce timer and flush microtasks (fake timers active). */
async function tick(ms = 300): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await vi.advanceTimersByTimeAsync(0);
}

/** Microtask-only flush (resolves already-settled promise continuations). */
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
      sort: 'meta.updated_at_desc',
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
    expect(both.updatedAfter).toBe(dayStartMs('2026-08-01'));
    expect(both.updatedBefore).toBe(dayEndMs('2026-08-15'));

    const fromOnly = buildSessionAdminQuery(filters({ updatedFrom: '2026-08-01' }), 1, 20);
    expect(fromOnly.updatedAfter).toBe(dayStartMs('2026-08-01'));
    expect(fromOnly.updatedBefore).toBeUndefined();

    const toOnly = buildSessionAdminQuery(filters({ updatedTo: '2026-08-15' }), 1, 20);
    expect(toOnly.updatedAfter).toBeUndefined();
    expect(toOnly.updatedBefore).toBe(dayEndMs('2026-08-15'));
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
    const { admin, listSessionsV2 } = createAdmin();

    admin.ensureSeeded();
    expect(admin.state.loading).toBe(true);
    await flush();

    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    expect(listSessionsV2).toHaveBeenLastCalledWith({
      workspaceIds: undefined,      archived: 'all',
      updatedAfter: undefined,
      updatedBefore: undefined,
      sort: 'meta.updated_at_desc',
      page: 1,
      pageSize: 20,
    });
    expect(admin.state.items.map((s) => s.id)).toEqual(['s1']);
    expect(admin.state.total).toBe(1);
    expect(admin.state.loading).toBe(false);

    admin.ensureSeeded();
    expect(listSessionsV2).toHaveBeenCalledTimes(1);
  });

  it('applyFilters on an unseeded admin doubles as the seed — one fetch, ensureSeeded no-ops', async () => {
    const { admin, listSessionsV2 } = createAdmin();

    admin.applyFilters({ workspaceIds: ['ws1'], status: 'all', updatedFrom: '', updatedTo: '' });
    await flush();
    expect(listSessionsV2).toHaveBeenCalledTimes(1);
    expect(admin.state.seeded).toBe(true);

    // The entry watcher's ensureSeeded must not fire a duplicate first-page
    // request (the workspace home's 查看更多 path applies before switching).
    admin.ensureSeeded();
    await flush();
    expect(listSessionsV2).toHaveBeenCalledTimes(1);
  });

  it('debounces filter changes: rapid setters collapse into one fetch with the latest params', async () => {
    const { admin, listSessionsV2 } = createAdmin();
    admin.ensureSeeded();
    await flush();

    admin.setStatus('done');
    admin.setWorkspaceIds(['ws2']);
    admin.setTimeRange('2026-08-01', '');
    expect(listSessionsV2).toHaveBeenCalledTimes(1); // still only the seed
    await tick();

    expect(listSessionsV2).toHaveBeenCalledTimes(2);
    expect(listSessionsV2).toHaveBeenLastCalledWith({
      workspaceIds: ['ws2'],
      archived: true,
      updatedAfter: dayStartMs('2026-08-01'),
      updatedBefore: undefined,
      sort: 'meta.updated_at_desc',
      page: 1,
      pageSize: 20,
    });
  });

  it('resets to page 1 on filter/pageSize changes, keeps it on page navigation', async () => {
    const { admin, listSessionsV2 } = createAdmin();
    // A deep enough result set for page-3 navigation to be valid.
    listSessionsV2.mockResolvedValue(page([v2('s1')], 100));
    admin.ensureSeeded();
    await flush();

    admin.setPage(3);
    await tick();
    expect(admin.state.page).toBe(3);
    expect(listSessionsV2).toHaveBeenLastCalledWith(expect.objectContaining({ page: 3 }));

    admin.setStatus('open');
    await tick();
    expect(admin.state.page).toBe(1);
    expect(listSessionsV2).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, archived: false }),
    );

    admin.setPage(2);
    await tick();
    expect(admin.state.page).toBe(2);
    admin.setPageSize(50);
    await tick();
    expect(admin.state.page).toBe(1);
    expect(listSessionsV2).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, pageSize: 50 }),
    );

    // No-op setters don't schedule a fetch.
    const calls = listSessionsV2.mock.calls.length;
    admin.setPage(1);
    admin.setPageSize(50);
    await tick();
    expect(listSessionsV2).toHaveBeenCalledTimes(calls);
  });

  it('drops stale responses: a slow older request never overwrites a newer one', async () => {
    let resolveOld!: (p: V2SessionsPage) => void;
    let resolveNew!: (p: V2SessionsPage) => void;
    const listSessionsV2 = vi
      .fn()
      .mockReturnValueOnce(new Promise<V2SessionsPage>((r) => (resolveOld = r)))
      .mockReturnValueOnce(new Promise<V2SessionsPage>((r) => (resolveNew = r)));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2 });
    const admin = useSessionAdmin({
      pushOperationFailure: vi.fn(),
      applySessionsArchivedLocally: vi.fn().mockResolvedValue(undefined),
    });

    admin.setStatus('done');
    await tick(); // old request (archived: true) in flight
    admin.setStatus('open');
    await tick(); // new request (archived: false) supersedes it

    resolveNew(page([v2('new')]));
    await flush();
    expect(admin.state.items.map((s) => s.id)).toEqual(['new']);
    expect(admin.state.loading).toBe(false);

    // The older request settles LATE — it must not clobber the newer state.
    resolveOld(page([v2('old')]));
    await flush();
    expect(admin.state.items.map((s) => s.id)).toEqual(['new']);
  });

  it('clamps the page when the server-side total shrank, then refetches the valid page', async () => {
    const listSessionsV2 = vi
      .fn()
      .mockResolvedValueOnce(page([v2('s1')], 30)) // seed: 30 rows, 3 pages of 10…
      .mockResolvedValueOnce(page([], 30))
      .mockResolvedValueOnce(page([], 5)) // total shrank: only 1 page of 10 left
      .mockResolvedValueOnce(page([v2('s2')], 5));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2 });
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
    // The page-3 response reports total 5 → maxPage 1: clamp + refetch.
    await flush();
    expect(admin.state.page).toBe(1);
    expect(listSessionsV2).toHaveBeenCalledTimes(4);
    expect(listSessionsV2).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
  });

  it('applyFilters writes the draft at once, resets to page 1, and fires exactly one immediate request', async () => {
    const { admin, listSessionsV2 } = createAdmin();
    listSessionsV2.mockResolvedValue(page([v2('s1')], 100));
    admin.ensureSeeded();
    await flush();
    admin.setPage(3);
    await tick();
    expect(admin.state.page).toBe(3);
    const callsBefore = listSessionsV2.mock.calls.length;

    admin.applyFilters({
      workspaceIds: ['ws9'],
      status: 'done',
      updatedFrom: '2026-08-01',
      updatedTo: '2026-08-15',
    });
    await flush(); // no 300ms debounce wait — the apply fires immediately

    expect(listSessionsV2.mock.calls.length).toBe(callsBefore + 1);
    expect(listSessionsV2).toHaveBeenLastCalledWith({
      workspaceIds: ['ws9'],
      archived: true,
      updatedAfter: dayStartMs('2026-08-01'),
      updatedBefore: dayEndMs('2026-08-15'),
      sort: 'meta.updated_at_desc',
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
    const listSessionsV2 = vi
      .fn()
      .mockResolvedValueOnce(page([v2('s1')]))
      .mockRejectedValueOnce(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2 });
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

    // Header checkbox: add the whole page; again → remove exactly that page.
    admin.togglePageSelection([
      { id: 'p1', archived: false },
      { id: 'p2', archived: true },
    ]);
    expect(admin.state.selectedIds.has('p1')).toBe(true);
    expect(admin.state.selectedIds.has('p2')).toBe(true);
    expect(admin.state.selectedIds.has('s2')).toBe(true); // other pages untouched
    admin.togglePageSelection([
      { id: 'p1', archived: false },
      { id: 'p2', archived: true },
    ]);
    expect(admin.state.selectedIds.has('p1')).toBe(false);
    expect(admin.state.selectedIds.has('p2')).toBe(false);
    expect(admin.state.selectedIds.has('s2')).toBe(true);
  });

  it('keeps the selection across page/filter changes; setSelection collapses; clear empties', async () => {
    const { admin, listSessionsV2 } = createAdmin();
    admin.ensureSeeded();
    await flush();
    listSessionsV2.mockResolvedValue(page([v2('s1')], 100));

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
    const { admin, listSessionsV2 } = createAdmin();
    admin.ensureSeeded();
    await flush();

    admin.toggleSelection('s1', false);
    expect(admin.state.selectedArchivedById.get('s1')).toBe(false);

    // The next fetch reports the same row archived (e.g. completed elsewhere).
    listSessionsV2.mockResolvedValue(page([v2('s1', true)]));
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
    const listSessionsV2 = vi.fn().mockResolvedValue(page([v2('s1')]));
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
    getKimiWebApiMock.mockReturnValue({ listSessionsV2, archiveSessions, restoreSessions });
    const pushOperationFailure = vi.fn();
    const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
    const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
    return {
      admin,
      listSessionsV2,
      archiveSessions,
      restoreSessions,
      pushOperationFailure,
      applySessionsArchivedLocally,
    };
  }

  it('partial success: ok ids reconcile + leave the selection, failed ids stay; the page re-pulls', async () => {
    const { admin, archiveSessions, applySessionsArchivedLocally, listSessionsV2 } =
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
    const fetches = listSessionsV2.mock.calls.length;

    const outcome = await admin.archiveSessions(['s1', 's2', 's3']);

    expect(archiveSessions).toHaveBeenCalledWith(['s1', 's2', 's3']);
    expect(outcome).toEqual({ okIds: ['s1', 's2'], succeeded: 2, failed: 1 });
    expect(applySessionsArchivedLocally).toHaveBeenCalledWith(['s1', 's2'], true);
    expect([...admin.state.selectedIds]).toEqual(['s3']);
    expect(admin.state.selectedArchivedById.has('s1')).toBe(false);
    // Silent re-pull of the current page after the batch.
    expect(listSessionsV2.mock.calls.length).toBe(fetches + 1);
  });

  it('all failed: no local reconcile, no re-pull, selection untouched', async () => {
    const { admin, applySessionsArchivedLocally, listSessionsV2 } = createBatchAdmin([
      { id: 's1', ok: false },
      { id: 's2', ok: false },
    ]);
    admin.ensureSeeded();
    await flush();
    admin.toggleSelection('s1', false);
    admin.toggleSelection('s2', false);
    const fetches = listSessionsV2.mock.calls.length;

    const outcome = await admin.archiveSessions(['s1', 's2']);

    expect(outcome).toEqual({ okIds: [], succeeded: 0, failed: 2 });
    expect(applySessionsArchivedLocally).not.toHaveBeenCalled();
    expect([...admin.state.selectedIds].sort()).toEqual(['s1', 's2']);
    expect(listSessionsV2.mock.calls.length).toBe(fetches);
  });

  it('endpoint throw: surfaces via pushOperationFailure, outcome counts everything failed', async () => {
    const listSessionsV2 = vi.fn().mockResolvedValue(page([v2('s1')]));
    const archiveSessions = vi.fn().mockRejectedValue(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2, archiveSessions });
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
    const listSessionsV2 = vi.fn().mockResolvedValue(page([v2('s1')]));
    const listSessionIdsV2 = vi.fn().mockResolvedValue({
      items: [
        { id: 'm1', archived: false },
        { id: 'm2', archived: true },
      ],
      hasMore: false,
      nextPageToken: null,
      total: 2,
    });
    getKimiWebApiMock.mockReturnValue({ listSessionsV2, listSessionIdsV2 });
    const pushOperationFailure = vi.fn();
    const applySessionsArchivedLocally = vi.fn().mockResolvedValue(undefined);
    const admin = useSessionAdmin({ pushOperationFailure, applySessionsArchivedLocally });
    return { admin, listSessionsV2, listSessionIdsV2, pushOperationFailure };
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
      updatedBefore: dayEndMs('2026-08-15'),
      sort: 'meta.updated_at_desc',
    });
  });

  it('materializes every matching id with its archived flag and sets allMatching', async () => {
    const { admin, listSessionIdsV2 } = createMatchingAdmin();
    admin.ensureSeeded();
    await flush();

    await admin.selectAllMatching();

    expect(listSessionIdsV2).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 10000, pageToken: undefined }),
    );
    expect([...admin.state.selectedIds].sort()).toEqual(['m1', 'm2']);
    expect(admin.state.selectedArchivedById.get('m1')).toBe(false);
    expect(admin.state.selectedArchivedById.get('m2')).toBe(true);
    expect(admin.state.allMatching).toBe(true);
    expect(admin.state.materializingAll).toBe(false);
  });

  it('cursor-walks the projection in pages until hasMore is false', async () => {
    const { admin, listSessionIdsV2 } = createMatchingAdmin();
    listSessionIdsV2
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

    expect(listSessionIdsV2).toHaveBeenCalledTimes(2);
    expect(listSessionIdsV2).toHaveBeenLastCalledWith(
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

    // Unchecking one row is an exclusion — the mode survives.
    admin.toggleSelection('m1', false);
    expect(admin.state.allMatching).toBe(true);
    expect([...admin.state.selectedIds].sort()).toEqual(['h1', 'm2']);

    // Unchecking the last rows empties the selection — the mode dies with it.
    admin.toggleSelection('h1', false);
    admin.toggleSelection('m2', true);
    expect(admin.state.allMatching).toBe(false);
  });

  it('a fully successful batch empties the selection and exits all-matching mode', async () => {
    const { admin, listSessionsV2, listSessionIdsV2 } = createMatchingAdmin();
    const archiveSessions = vi.fn().mockResolvedValue({
      results: [
        { id: 'm1', ok: true },
        { id: 'm2', ok: true },
      ],
      succeeded: 2,
      failed: 0,
    });
    getKimiWebApiMock.mockReturnValue({ listSessionsV2, listSessionIdsV2, archiveSessions });
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
    const { admin, listSessionsV2 } = createMatchingAdmin();
    admin.ensureSeeded();
    await flush();
    await admin.selectAllMatching();

    // Re-applying the same conditions keeps the materialized set…
    admin.applyFilters({ workspaceIds: [], status: 'all', updatedFrom: '', updatedTo: '' });
    await tick();
    expect(admin.state.allMatching).toBe(true);
    expect(admin.state.selectedIds.size).toBe(2);

    // … but a real change clears it entirely (Gmail: new query, new world).
    admin.applyFilters({ workspaceIds: [], status: 'done', updatedFrom: '', updatedTo: '' });
    await tick();
    expect(admin.state.allMatching).toBe(false);
    expect(admin.state.selectedIds.size).toBe(0);
    expect(listSessionsV2).toHaveBeenCalled();
  });

  it('discards the materialization when the filters move mid-flight', async () => {
    const { admin } = createMatchingAdmin();
    admin.ensureSeeded();
    await flush();
    let resolveIds: ((page: unknown) => void) | undefined;
    const { listSessionIdsV2 } = { listSessionIdsV2: vi.fn() };
    void listSessionIdsV2;
    // Rebuild the api mock with a hanging ids call.
    const hanging = new Promise((r) => {
      resolveIds = r;
    });
    getKimiWebApiMock.mockReturnValue({
      listSessionsV2: vi.fn().mockResolvedValue(page([v2('s1')])),
      listSessionIdsV2: vi.fn().mockReturnValue(hanging),
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
    const listSessionsV2 = vi.fn().mockResolvedValue(page([v2('s1')]));
    const archiveSessions = vi
      .fn()
      .mockImplementation((ids: string[]) => Promise.resolve(okResults(ids)));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2, archiveSessions });
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
    const listSessionsV2 = vi.fn().mockResolvedValue(page([v2('s1')]));
    const archiveSessions = vi.fn().mockRejectedValue(new Error('boom'));
    getKimiWebApiMock.mockReturnValue({ listSessionsV2, archiveSessions });
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

    // Full success.
    expect(
      planAdminBatchToast('archive', { okIds: ['a', 'b'], succeeded: 2, failed: 0 }),
    ).toEqual({ direction: 'archive', ids: ['a', 'b'], succeeded: 2, failed: 0 });
    // Partial: the undo set is exactly the successes; the failed count rides along.
    expect(
      planAdminBatchToast('restore', { okIds: ['a'], succeeded: 1, failed: 2 }),
    ).toEqual({ direction: 'restore', ids: ['a'], succeeded: 1, failed: 2 });
    // All failed → no toast (the error notice covers it).
    expect(planAdminBatchToast('archive', { okIds: [], succeeded: 0, failed: 3 })).toBeNull();

    expect(undoBatchDirectionOf('archive')).toBe('restore');
    expect(undoBatchDirectionOf('restore')).toBe('archive');
  });
});
