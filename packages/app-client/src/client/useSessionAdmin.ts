// packages/app-client/src/client/useSessionAdmin.ts
// Session admin page (/admin/sessions) data layer: server-side paged table
// state + request orchestration. Every filter/page change is ONE
// GET /api/v2/sessions call with all conditions pushed down (page mode —
// stateless, no pageToken); there is no client-side aggregation or slicing.
//
// Orchestration: setters update state synchronously (the filter UI stays
// responsive) and schedule a debounced fetch; a monotonically increasing
// serial drops stale responses, so a slow earlier request can never
// overwrite a newer one.

import { reactive } from 'vue';
import { getKimiWebApi } from './deps';
import type {
  ListSessionIdsV2Input,
  ListSessionsV2Input,
  V2BatchSessionResponse,
  V2Session,
} from '@moonshot-ai/app-core/api';

export type SessionAdminStatusFilter = 'all' | 'open' | 'done';

export interface SessionAdminFilters {
  /** Workspace ids, OR semantics server-side. Empty = no workspace filter. */
  workspaceIds: string[];
  /** Lifecycle filter → the wire `archived` tri-state ('all'/false/true). */
  status: SessionAdminStatusFilter;
  /** Local calendar-day bounds 'YYYY-MM-DD'; '' = unbounded on that side. */
  updatedFrom: string;
  updatedTo: string;
}

export interface SessionAdminState {
  filters: SessionAdminFilters;
  page: number;
  pageSize: number;
  items: V2Session[];
  total: number;
  loading: boolean;
  /** One-shot seed guard (same ensure* semantics as the sidebar lists). */
  seeded: boolean;
  /** Selected row ids — kept across pages AND filter changes (GitHub
   *  semantics: the batch bar's count includes rows no longer visible).
   *  Successful batch items are removed; failed ones stay selected. */
  selectedIds: Set<string>;
  /** Lifecycle (archived) per selected id, recorded when the row is toggled
   *  (rows are always visible at toggle time) and reconciled on every items
   *  landing. Drives the batch bar's Mark-as-done/Reopen counts + disables —
   *  the server-side page model can't look up off-page rows otherwise. */
  selectedArchivedById: Map<string, boolean>;
  /** Gmail-style select-all-matching: true once every id matching the current
   *  filters has been materialized into the selection via the batch bar link
   *  (ids projection). Row-level unchecks are exclusions from it; the mode
   *  dies on a filter change (the fingerprint it was built from no longer
   *  applies), on a single-row collapse, or when the selection empties. */
  allMatching: boolean;
  /** True while the matching ids are being fetched (the link's busy state). */
  materializingAll: boolean;
}

export const SESSION_ADMIN_DEFAULT_PAGE_SIZE = 20;
const FETCH_DEBOUNCE_MS = 300;
/** Wire caps: the ids projection's page_size ceiling and the batch endpoints'
 *  unique-ids ceiling — select-all fetches and batch executions chunk on them. */
export const SESSION_ADMIN_IDS_PAGE_SIZE = 10000;
export const SESSION_ADMIN_BATCH_IDS_MAX = 5000;

/** Local-day start (00:00:00.000) in Unix ms for a 'YYYY-MM-DD' string.
 *  Parsed by hand — `new Date('YYYY-MM-DD')` is UTC midnight, not local. */
export function dayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

/** Local-day end (23:59:59.999) in Unix ms. */
export function dayEndMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999).getTime();
}

/** Build the wire query — the single place request params are mapped
 *  (tests pin this mapping; the fetch path adds nothing else). */
export function buildSessionAdminQuery(
  filters: SessionAdminFilters,
  page: number,
  pageSize: number,
): ListSessionsV2Input {
  return {
    workspaceIds: filters.workspaceIds.length > 0 ? [...filters.workspaceIds] : undefined,
    archived: filters.status === 'all' ? 'all' : filters.status === 'done',
    updatedAfter: filters.updatedFrom !== '' ? dayStartMs(filters.updatedFrom) : undefined,
    updatedBefore: filters.updatedTo !== '' ? dayEndMs(filters.updatedTo) : undefined,
    sort: 'meta.updated_at_desc',
    page,
    pageSize,
  };
}

/** The ids-projection variant of the query mapping (no paging — the caller
 *  walks the cursor): the exact same conditions select-all materializes. */
export function buildSessionAdminIdsQuery(filters: SessionAdminFilters): ListSessionIdsV2Input {
  return {
    workspaceIds: filters.workspaceIds.length > 0 ? [...filters.workspaceIds] : undefined,
    archived: filters.status === 'all' ? 'all' : filters.status === 'done',
    updatedAfter: filters.updatedFrom !== '' ? dayStartMs(filters.updatedFrom) : undefined,
    updatedBefore: filters.updatedTo !== '' ? dayEndMs(filters.updatedTo) : undefined,
    sort: 'meta.updated_at_desc',
  };
}

/** Canonical key of the filter set — select-all-matching ties itself to the
 *  fingerprint it was built from and dies on any change. */
export function sessionAdminFiltersKey(filters: SessionAdminFilters): string {
  return JSON.stringify([
    [...filters.workspaceIds].toSorted(),
    filters.status,
    filters.updatedFrom,
    filters.updatedTo,
  ]);
}

export interface UseSessionAdminDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  /** Sidebar-local archive/restore reconciliation (pool ⇄ done list), shared
   *  with the single-session paths — the batch flow must not pay the
   *  per-session side effects (backfill/tracking) N times. */
  applySessionsArchivedLocally: (ids: string[], archived: boolean) => Promise<void>;
}

/** Outcome of one batch archive/restore call, shaped for the toast driver:
 *  okIds = per-item successes (the undo set), counts straight off the wire. */
export interface SessionAdminBatchOutcome {
  okIds: string[];
  succeeded: number;
  failed: number;
}

export function useSessionAdmin(deps: UseSessionAdminDeps) {
  const state = reactive<SessionAdminState>({
    filters: { workspaceIds: [], status: 'all', updatedFrom: '', updatedTo: '' },
    page: 1,
    pageSize: SESSION_ADMIN_DEFAULT_PAGE_SIZE,
    items: [],
    total: 0,
    loading: false,
    seeded: false,
    selectedIds: new Set<string>(),
    selectedArchivedById: new Map<string, boolean>(),
    allMatching: false,
    materializingAll: false,
  });

  let requestSerial = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  async function fetchNow(): Promise<void> {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    const serial = ++requestSerial;
    state.loading = true;
    try {
      const page = await getKimiWebApi().listSessionsV2(
        buildSessionAdminQuery(state.filters, state.page, state.pageSize),
      );
      if (serial !== requestSerial) return; // stale — a newer request owns the state
      state.items = page.items;
      state.total = page.total;
      // Fresh rows may carry lifecycle changes made elsewhere (another client,
      // the sidebar): reconcile the recorded states of still-selected rows so
      // the batch bar's counts/disables track the truth.
      for (const item of page.items) {
        if (state.selectedArchivedById.has(item.id)) {
          state.selectedArchivedById.set(item.id, item.meta.archived);
        }
      }
      // The server-side total shrank out from under the current page (rows
      // archived/restored by another client): clamp and pull the valid page.
      const maxPage = Math.max(1, Math.ceil(page.total / state.pageSize));
      if (state.page > maxPage) {
        state.page = maxPage;
        void fetchNow();
      }
    } catch (err) {
      if (serial !== requestSerial) return;
      deps.pushOperationFailure('sessionAdmin', err);
    } finally {
      if (serial === requestSerial) state.loading = false;
    }
  }

  function scheduleFetch(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void fetchNow();
    }, FETCH_DEBOUNCE_MS);
  }

  /** First entry into the page: pull page 1. One-shot; later entries keep the
   *  current state (P3 refreshes after batch mutations). */
  function ensureSeeded(): void {
    if (state.seeded) return;
    state.seeded = true;
    void fetchNow();
  }

  /** Silent re-pull of the current page with the current conditions (P3 uses
   *  it after batch operations; also the manual recovery path after a failed
   *  fetch). */
  async function refresh(): Promise<void> {
    await fetchNow();
  }

  /** Query-form apply (antd Pro semantics): write the whole filter draft at
   *  once, reset to page 1, and fire exactly ONE immediate request — the
   *  per-setter debounce path stays for granular updates, but a 查询 click or
   *  a 重置 must not dribble out staggered writes. A select-all-matching set
   *  only dies when the conditions actually change (re-applying the same
   *  query keeps it). */
  function applyFilters(f: SessionAdminFilters): void {
    if (state.allMatching && sessionAdminFiltersKey(f) !== sessionAdminFiltersKey(state.filters)) {
      clearSelection();
    }
    state.filters.workspaceIds = [...f.workspaceIds];
    state.filters.status = f.status;
    state.filters.updatedFrom = f.updatedFrom;
    state.filters.updatedTo = f.updatedTo;
    state.page = 1;
    // Applying conditions and fetching IS the seed — mark it so the entry
    // watcher's ensureSeeded no-ops instead of firing a duplicate first-page
    // request (the workspace home's 查看更多 path applies before switching).
    state.seeded = true;
    void fetchNow();
  }

  // Filter setters reset to page 1 (GitHub semantics: new conditions, new
  // window); page/pageSize setters keep the conditions. A granular change is
  // always a change — a select-all-matching set dies with it.
  function setWorkspaceIds(ids: string[]): void {
    if (state.allMatching) clearSelection();
    state.filters.workspaceIds = [...ids];
    state.page = 1;
    scheduleFetch();
  }

  function setStatus(status: SessionAdminStatusFilter): void {
    if (state.allMatching) clearSelection();
    state.filters.status = status;
    state.page = 1;
    scheduleFetch();
  }

  /** Update either bound of the time range ('' = unbounded). Both bounds are
   *  written together so a clear is one change → one fetch. */
  function setTimeRange(from: string, to: string): void {
    if (state.allMatching) clearSelection();
    state.filters.updatedFrom = from;
    state.filters.updatedTo = to;
    state.page = 1;
    scheduleFetch();
  }

  function setPage(page: number): void {
    if (page === state.page) return;
    state.page = page;
    scheduleFetch();
  }

  function setPageSize(pageSize: number): void {
    if (pageSize === state.pageSize) return;
    state.pageSize = pageSize;
    state.page = 1;
    scheduleFetch();
  }

  // ---------------------------------------------------------------------------
  // Selection (kept across pages and filter changes) + batch archive/restore.
  // ---------------------------------------------------------------------------

  function toggleSelection(id: string, archived: boolean): void {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      state.selectedArchivedById.delete(id);
      // An emptied selection drops the mode; partial unchecks are exclusions
      // from it (Gmail's "all except these").
      if (state.selectedIds.size === 0) state.allMatching = false;
      return;
    }
    state.selectedIds.add(id);
    state.selectedArchivedById.set(id, archived);
  }

  /** Header checkbox: every row of the CURRENT page selected → unselect them
   *  all; otherwise select the whole page (rows on other pages untouched). */
  function togglePageSelection(pageEntries: Array<{ id: string; archived: boolean }>): void {
    const allSelected =
      pageEntries.length > 0 && pageEntries.every((e) => state.selectedIds.has(e.id));
    for (const entry of pageEntries) {
      if (allSelected) {
        state.selectedIds.delete(entry.id);
        state.selectedArchivedById.delete(entry.id);
      } else {
        state.selectedIds.add(entry.id);
        state.selectedArchivedById.set(entry.id, entry.archived);
      }
    }
    if (state.selectedIds.size === 0) state.allMatching = false;
  }

  /** Collapse the selection to a single row (right-click outside the current
   *  multi-selection adopts the row under the cursor). */
  function setSelection(entries: Array<{ id: string; archived: boolean }>): void {
    state.selectedIds = new Set(entries.map((e) => e.id));
    state.selectedArchivedById = new Map(entries.map((e) => [e.id, e.archived]));
    state.allMatching = false;
  }

  function clearSelection(): void {
    state.selectedIds = new Set();
    state.selectedArchivedById = new Map();
    state.allMatching = false;
  }

  /** Gmail-style select-all-matching: materialize EVERY id matching the
   *  current filters into the selection via the ids projection (cursor-walked
   *  in 10000-id pages). Additions merge atomically — a filter change
   *  mid-flight discards the whole fetch. */
  async function selectAllMatching(): Promise<void> {
    if (state.allMatching || state.materializingAll) return;
    state.materializingAll = true;
    const input = buildSessionAdminIdsQuery(state.filters);
    const keyAtStart = sessionAdminFiltersKey(state.filters);
    try {
      const collected: Array<{ id: string; archived: boolean }> = [];
      let pageToken: string | undefined;
      for (;;) {
        const page = await getKimiWebApi().listSessionIdsV2({
          ...input,
          pageSize: SESSION_ADMIN_IDS_PAGE_SIZE,
          pageToken,
        });
        collected.push(...page.items);
        if (!page.hasMore || page.nextPageToken === null) break;
        pageToken = page.nextPageToken;
      }
      // The conditions moved while we were fetching — the materialized set
      // would silently belong to the old fingerprint; drop it entirely.
      if (sessionAdminFiltersKey(state.filters) !== keyAtStart) return;
      for (const item of collected) {
        state.selectedIds.add(item.id);
        state.selectedArchivedById.set(item.id, item.archived);
      }
      state.allMatching = true;
    } catch (err) {
      deps.pushOperationFailure('sessionAdmin', err);
    } finally {
      state.materializingAll = false;
    }
  }

  /** Selected ids split by their last known lifecycle — the batch bar runs
   *  Mark-as-done only on the open subset and Reopen only on the done subset
   *  (prototype: rows already in the target state are skipped). */
  function selectedIdsByArchived(archived: boolean): string[] {
    const out: string[] = [];
    for (const [id, value] of state.selectedArchivedById) {
      if (value === archived) out.push(id);
    }
    return out;
  }

  /** Run one archive/restore batch, chunked at the wire's 5000-unique-ids
   *  ceiling (select-all-matching can exceed it by far). Chunks run
   *  sequentially; a thrown chunk aborts the rest — its own and the remaining
   *  ids count as failed, the succeeded ones still apply. */
  async function runBatch(
    ids: string[],
    archived: boolean,
    call: (ids: string[]) => Promise<V2BatchSessionResponse>,
  ): Promise<SessionAdminBatchOutcome> {
    const okIds: string[] = [];
    let succeeded = 0;
    let failed = 0;
    for (let offset = 0; offset < ids.length; offset += SESSION_ADMIN_BATCH_IDS_MAX) {
      const chunk = ids.slice(offset, offset + SESSION_ADMIN_BATCH_IDS_MAX);
      try {
        const res = await call(chunk);
        const chunkOk = res.results.filter((r) => r.ok).map((r) => r.id);
        okIds.push(...chunkOk);
        succeeded += res.succeeded;
        failed += res.failed;
      } catch (err) {
        failed += ids.length - offset;
        deps.pushOperationFailure(archived ? 'archiveSessions' : 'restoreSessions', err);
        break;
      }
    }
    if (okIds.length > 0) {
      await deps.applySessionsArchivedLocally(okIds, archived);
      for (const id of okIds) {
        state.selectedIds.delete(id);
        state.selectedArchivedById.delete(id);
      }
      // An emptied selection exits all-matching mode — leaving it true with
      // zero rows would render "已选中全部 1 项" on the next manual check and
      // block re-materialization (same rule as toggleSelection).
      if (state.selectedIds.size === 0) state.allMatching = false;
      // Silent re-pull: rows enter/leave the current filter server-side.
      await refresh();
    }
    return { okIds, succeeded, failed };
  }

  /** Batch Mark-as-done. Single-row primary actions come through here too
   *  (ids of length 1) — one endpoint, one outcome shape. */
  async function archiveSessions(ids: string[]): Promise<SessionAdminBatchOutcome> {
    return runBatch(ids, true, (input) => getKimiWebApi().archiveSessions(input));
  }

  /** Batch Reopen — the exact inverse (and the undo of archiveSessions). */
  async function restoreSessions(ids: string[]): Promise<SessionAdminBatchOutcome> {
    return runBatch(ids, false, (input) => getKimiWebApi().restoreSessions(input));
  }

  return {
    state,
    ensureSeeded,
    refresh,
    applyFilters,
    setWorkspaceIds,
    setStatus,
    setTimeRange,
    setPage,
    setPageSize,
    toggleSelection,
    togglePageSelection,
    setSelection,
    clearSelection,
    selectAllMatching,
    selectedIdsByArchived,
    archiveSessions,
    restoreSessions,
  };
}

export type UseSessionAdmin = ReturnType<typeof useSessionAdmin>;
