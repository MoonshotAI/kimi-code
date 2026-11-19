
import { reactive } from 'vue';
import { getKimiWebApi } from './deps';
import type {
  AppSession,
  BatchSessionResponse,
  ListSessionIdsInput,
  ListSessionsInput,
} from '@moonshot-ai/app-core/api';

export type SessionAdminStatusFilter = 'all' | 'open' | 'done';

export interface SessionAdminFilters {
  workspaceIds: string[];
  status: SessionAdminStatusFilter;
  updatedFrom: string;
  updatedTo: string;
}

export interface SessionAdminState {
  filters: SessionAdminFilters;
  page: number;
  pageSize: number;
  items: AppSession[];
  total: number;
  loading: boolean;
  seeded: boolean;
  selectedIds: Set<string>;
  selectedArchivedById: Map<string, boolean>;
  allMatching: boolean;
  materializingAll: boolean;
}

const SESSION_ADMIN_DEFAULT_PAGE_SIZE = 20;
const FETCH_DEBOUNCE_MS = 300;
const SESSION_ADMIN_IDS_PAGE_SIZE = 10000;
const SESSION_ADMIN_BATCH_IDS_MAX = 5000;

export function dayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

export function dayEndMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1, 23, 59, 59, 999).getTime();
}

export function buildSessionAdminQuery(
  filters: SessionAdminFilters,
  page: number,
  pageSize: number,
): ListSessionsInput {
  return {
    workspaceIds: filters.workspaceIds.length > 0 ? [...filters.workspaceIds] : undefined,
    archived: filters.status === 'all' ? 'all' : filters.status === 'done',
    updatedAfter:
      filters.updatedFrom !== '' ? new Date(dayStartMs(filters.updatedFrom)).toISOString() : undefined,
    updatedBefore:
      filters.updatedTo !== '' ? new Date(dayEndMs(filters.updatedTo)).toISOString() : undefined,
    sort: 'updated_at_desc',
    page,
    pageSize,
  };
}

export function buildSessionAdminIdsQuery(filters: SessionAdminFilters): ListSessionIdsInput {
  return {
    workspaceIds: filters.workspaceIds.length > 0 ? [...filters.workspaceIds] : undefined,
    archived: filters.status === 'all' ? 'all' : filters.status === 'done',
    updatedAfter:
      filters.updatedFrom !== '' ? new Date(dayStartMs(filters.updatedFrom)).toISOString() : undefined,
    updatedBefore:
      filters.updatedTo !== '' ? new Date(dayEndMs(filters.updatedTo)).toISOString() : undefined,
    sort: 'updated_at_desc',
  };
}

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
  applySessionsArchivedLocally: (ids: string[], archived: boolean) => Promise<void>;
}

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
      const page = await getKimiWebApi().listSessions(
        buildSessionAdminQuery(state.filters, state.page, state.pageSize),
      );
      if (serial !== requestSerial) return;
      state.items = page.items;
      state.total = page.total;
      for (const item of page.items) {
        if (state.selectedArchivedById.has(item.id)) {
          state.selectedArchivedById.set(item.id, item.archived);
        }
      }
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

  function ensureSeeded(): void {
    if (state.seeded) return;
    state.seeded = true;
    void fetchNow();
  }

  async function refresh(): Promise<void> {
    await fetchNow();
  }

  function applyFilters(f: SessionAdminFilters): void {
    if (state.allMatching && sessionAdminFiltersKey(f) !== sessionAdminFiltersKey(state.filters)) {
      clearSelection();
    }
    state.filters.workspaceIds = [...f.workspaceIds];
    state.filters.status = f.status;
    state.filters.updatedFrom = f.updatedFrom;
    state.filters.updatedTo = f.updatedTo;
    state.page = 1;
    state.seeded = true;
    void fetchNow();
  }

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

  function toggleSelection(id: string, archived: boolean): void {
    if (state.selectedIds.has(id)) {
      state.selectedIds.delete(id);
      state.selectedArchivedById.delete(id);
      if (state.selectedIds.size === 0) state.allMatching = false;
      return;
    }
    state.selectedIds.add(id);
    state.selectedArchivedById.set(id, archived);
  }

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

  function dropSession(id: string): void {
    requestSerial += 1;
    state.loading = false;
    state.items = state.items.filter((s) => s.id !== id);
    state.selectedIds.delete(id);
    state.selectedArchivedById.delete(id);
    if (state.selectedIds.size === 0) state.allMatching = false;
    if (state.seeded) void fetchNow();
  }

  async function selectAllMatching(): Promise<void> {
    if (state.allMatching || state.materializingAll) return;
    state.materializingAll = true;
    const serialAtStart = requestSerial;
    const input = buildSessionAdminIdsQuery(state.filters);
    const keyAtStart = sessionAdminFiltersKey(state.filters);
    try {
      const collected: Array<{ id: string; archived: boolean }> = [];
      let pageToken: string | undefined;
      for (;;) {
        const page = await getKimiWebApi().listSessionIds({
          ...input,
          pageSize: SESSION_ADMIN_IDS_PAGE_SIZE,
          pageToken,
        });
        collected.push(...page.items);
        if (!page.hasMore || page.nextPageToken === null) break;
        pageToken = page.nextPageToken;
      }
      if (sessionAdminFiltersKey(state.filters) !== keyAtStart) return;
      if (serialAtStart !== requestSerial) return;
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

  function selectedIdsByArchived(archived: boolean): string[] {
    const out: string[] = [];
    for (const [id, value] of state.selectedArchivedById) {
      if (value === archived) out.push(id);
    }
    return out;
  }

  async function runBatch(
    ids: string[],
    archived: boolean,
    call: (ids: string[]) => Promise<BatchSessionResponse>,
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
      if (state.selectedIds.size === 0) state.allMatching = false;
      await refresh();
    }
    return { okIds, succeeded, failed };
  }

  async function archiveSessions(ids: string[]): Promise<SessionAdminBatchOutcome> {
    return runBatch(ids, true, (input) => getKimiWebApi().archiveSessions(input));
  }

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
    dropSession,
    selectAllMatching,
    selectedIdsByArchived,
    archiveSessions,
    restoreSessions,
  };
}

export type UseSessionAdmin = ReturnType<typeof useSessionAdmin>;
