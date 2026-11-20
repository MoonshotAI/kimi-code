
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

const memStorage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void memStorage.set(key, value),
  removeItem: (key: string) => void memStorage.delete(key),
  clear: () => memStorage.clear(),
});

import type { AppSession, AppWorkspace, KimiWebApi } from '@moonshot-ai/app-core/api';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import {
  loadActiveWorkspace,
  loadHiddenWorkspaceIds,
  loadPinnedWorkspaces,
  loadWorkspaceNameOverridesById,
  loadWorkspaceOrder,
  loadWorkspaceRecencyFloor,
  loadWorkspaceSort,
  STORAGE_KEYS,
} from '@moonshot-ai/app-core/lib';
import { resetKimiClientDeps, setKimiClientDeps } from '../src/client/deps';
import { noopProductTracker, setProductTracker } from '../src/contracts';
import { hostsStore } from '../src/stores/hosts';
import { sessionsStore } from '../src/stores/sessions';
import { warningsStore } from '../src/stores/warnings';
import { SESSIONS_INITIAL_PAGE_SIZE, setWorkspacesHooks, workspacesStore } from '../src/stores/workspaces';
import type { SessionGroupsMapping } from '../src/stores/workspaces';

function makeWorkspace(id: string, root: string, extra?: Partial<AppWorkspace>): AppWorkspace {
  return {
    id,
    root,
    name: root.split('/').pop() ?? root,
    kind: id.startsWith('wm_') ? 'managed' : 'implicit',
    sessionCount: 1,
    additionalDirs: [],
    ...extra,
  } as AppWorkspace;
}

function makeSession(id: string, updatedAt: string, extra?: Partial<AppSession>): AppSession {
  return {
    id,
    title: `Session ${id}`,
    createdAt: updatedAt,
    updatedAt,
    cwd: '/ws',
    ...extra,
  } as AppSession;
}

function makeMapping(
  entries: Record<string, { hasMore: boolean; cursor?: string; count?: number }>,
): SessionGroupsMapping {
  const hasMore: Record<string, boolean> = {};
  const cursors: Record<string, string | undefined> = {};
  const counts: Record<string, number> = {};
  for (const [id, e] of Object.entries(entries)) {
    hasMore[id] = e.hasMore;
    cursors[id] = e.cursor;
    counts[id] = e.count ?? SESSIONS_INITIAL_PAGE_SIZE;
  }
  return { loaded: [], hasMore, cursors, counts, liveIds: [] };
}

function resetStore(): void {
  const store = workspacesStore();
  store.workspaces = [];
  store.storedActiveWorkspaceId = null;
  store.fsHome = null;
  store.recentRoots = [];
  store.hiddenWorkspaceIds = [];
  store.showCliWorkspaces = true;
  store.workspaceOrder = [];
  store.pinnedWorkspaceIds = [];
  store.workspaceSortMode = 'manual';
  store.workspaceRecencyFloor = {};
  store.sessionsHasMoreByWorkspace = {};
  store.sessionsLoadingMoreByWorkspace = {};
  store.sessionsCursorByWorkspace = {};
  store.sessionsInitialCountByWorkspace = {};
  sessionsStore().setSessions([]);
}

beforeEach(() => {
  memStorage.clear();
  resetStore();
});

describe('workspacesView ordering', () => {
  it('manual mode follows the persisted order, unplaced workspaces first', () => {
    const store = workspacesStore();
    store.workspaces = [
      makeWorkspace('c', '/c'),
      makeWorkspace('b', '/b'),
      makeWorkspace('a', '/a'),
    ];
    store.workspaceOrder = ['a', 'b'];
    expect(store.workspacesView.map((w) => w.id)).toEqual(['c', 'a', 'b']);
  });

  it('recent mode sorts by max(floor, last_opened_at), unknown last', () => {
    const store = workspacesStore();
    store.workspaces = [
      makeWorkspace('a', '/a'),
      makeWorkspace('b', '/b', { lastOpenedAt: '2026-01-02T00:00:00.000Z' } as Partial<AppWorkspace>),
      makeWorkspace('c', '/c'),
    ];
    store.workspaceSortMode = 'recent';
    store.workspaceRecencyFloor = { a: Date.parse('2026-01-03T00:00:00.000Z') };
    expect(store.workspacesView.map((w) => w.id)).toEqual(['a', 'b', 'c']);
  });

  it('shortens the home prefix in shortPath once fsHome is known', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/Users/x/code/app')];
    store.fsHome = '/Users/x';
    expect(store.workspacesView[0]!.shortPath).toBe('~/code/app');
  });

  it('keeps remote roots unshortened because the local home does not apply to them', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/home/x/code/app', { hostId: 'devbox' })];
    store.fsHome = '/Users/x';
    expect(store.workspacesView[0]!.shortPath).toBe('/home/x/code/app');
  });
});

describe('CLI workspace visibility', () => {
  it('hides implicit workspaces by default and restores them with the persisted opt-in', () => {
    const store = workspacesStore();
    store.showCliWorkspaces = false;
    store.workspaces = [
      makeWorkspace('wd_tui', '/tui'),
      makeWorkspace('wm_app', '/app'),
    ];
    store.storedActiveWorkspaceId = 'wd_tui';

    expect(store.workspacesView.map((workspace) => workspace.id)).toEqual(['wm_app']);
    expect(store.visibleWorkspaceIds.has('wd_tui')).toBe(false);
    expect(store.activeWorkspaceId).toBe('wm_app');

    store.setShowCliWorkspaces(true);

    expect(store.workspacesView.map((workspace) => workspace.id)).toEqual(['wd_tui', 'wm_app']);
    expect(store.workspacesView[0]?.kind).toBe('implicit');
    expect(store.visibleWorkspaceIds.has('wd_tui')).toBe(true);
    expect(store.activeWorkspaceId).toBe('wd_tui');
    expect(memStorage.get(STORAGE_KEYS.showCliWorkspaces)).toBe('1');

    store.setShowCliWorkspaces(false);
    expect(memStorage.get(STORAGE_KEYS.showCliWorkspaces)).toBe('0');
  });
});

describe('ordering actions', () => {
  it('reorderWorkspaces replaces the order and persists it', () => {
    const store = workspacesStore();
    store.reorderWorkspaces(['b', 'a']);
    expect(store.workspaceOrder).toEqual(['b', 'a']);
    expect(loadWorkspaceOrder()).toEqual(['b', 'a']);
  });

  it('setWorkspaceSortMode is a no-op for the current mode and persists changes', () => {
    const store = workspacesStore();
    store.setWorkspaceSortMode('manual');
    expect(loadWorkspaceSort()).toBe('manual');
    store.setWorkspaceSortMode('recent');
    expect(store.workspaceSortMode).toBe('recent');
    expect(loadWorkspaceSort()).toBe('recent');
  });

  it('reconcileOrder prepends new ids, drops stale ones and prunes the floor', () => {
    const store = workspacesStore();
    store.workspaceOrder = ['a', 'gone'];
    store.workspaceRecencyFloor = { a: 10, gone: 20 };
    store.reconcileOrder(['new', 'a']);
    expect(store.workspaceOrder).toEqual(['new', 'a']);
    expect(loadWorkspaceOrder()).toEqual(['new', 'a']);
    expect(store.workspaceRecencyFloor).toEqual({ a: 10 });
    expect(loadWorkspaceRecencyFloor()).toEqual({ a: 10 });
  });

  it('reconcileOrder seeds the first-launch order by recency rank', () => {
    const store = workspacesStore();
    store.workspaces = [
      makeWorkspace('a', '/a'),
      makeWorkspace('b', '/b', { lastOpenedAt: '2026-01-02T00:00:00.000Z' } as Partial<AppWorkspace>),
    ];
    store.workspaceRecencyFloor = { a: Date.parse('2026-01-03T00:00:00.000Z') };
    store.reconcileOrder(['a', 'b']);
    expect(store.workspaceOrder).toEqual(['a', 'b']);
  });
});

describe('workspace pinning', () => {
  it('pins, toggles and persists workspace ids without duplicates', () => {
    const store = workspacesStore();
    store.pinWorkspace('a');
    store.pinWorkspace('a');
    store.pinWorkspace('b');
    expect(store.pinnedWorkspaceIds).toEqual(['a', 'b']);
    expect(loadPinnedWorkspaces()).toEqual(['a', 'b']);

    store.togglePinWorkspace('a');
    expect(store.pinnedWorkspaceIds).toEqual(['b']);
    expect(loadPinnedWorkspaces()).toEqual(['b']);

    store.togglePinWorkspace('a');
    expect(store.pinnedWorkspaceIds).toEqual(['b', 'a']);
    expect(loadPinnedWorkspaces()).toEqual(['b', 'a']);
  });

  it('drops pinned state when a workspace is hidden or removed', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.pinWorkspace('a');
    store.pinWorkspace('b');

    store.hideWorkspace('a');
    expect(store.pinnedWorkspaceIds).toEqual(['b']);
    expect(loadPinnedWorkspaces()).toEqual(['b']);

    store.removeWorkspaceEntries('b');
    expect(store.pinnedWorkspaceIds).toEqual([]);
    expect(loadPinnedWorkspaces()).toEqual([]);
  });
});

describe('active workspace resolution', () => {
  it('keeps a valid stored selection', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.storedActiveWorkspaceId = 'b';
    expect(store.activeWorkspaceId).toBe('b');
    expect(store.visibleWorkspace?.root).toBe('/b');
  });

  it('falls back to the first visible workspace for a stale selection', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.workspaceOrder = ['b', 'a'];
    store.storedActiveWorkspaceId = 'gone';
    expect(store.activeWorkspaceId).toBe('b');
  });

  it('resolves to null when no workspace exists', () => {
    expect(workspacesStore().activeWorkspaceId).toBeNull();
    expect(workspacesStore().visibleWorkspace).toBeNull();
  });

  it('treats only a workspace on an SSH host as non-local', () => {
    const store = workspacesStore();
    expect(store.isLocalWorkspace).toBe(true);
    store.workspaces = [
      makeWorkspace('a', '/a'),
      makeWorkspace('b', '/b', { hostId: 'devbox' }),
    ];
    store.storedActiveWorkspaceId = 'a';
    expect(store.isLocalWorkspace).toBe(true);
    store.storedActiveWorkspaceId = 'b';
    expect(store.isLocalWorkspace).toBe(false);
  });

  it('selectWorkspace writes the selection and persists it', () => {
    const store = workspacesStore();
    store.selectWorkspace('a');
    expect(store.storedActiveWorkspaceId).toBe('a');
    expect(loadActiveWorkspace()).toBe('a');
  });
});

describe('registry lifecycle', () => {
  it('upsertWorkspacePreserveOrder prepends truly new workspaces', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    store.upsertWorkspacePreserveOrder(makeWorkspace('b', '/b'));
    expect(store.workspaces.map((w) => w.id)).toEqual(['b', 'a']);
  });

  it('upsertWorkspacePreserveOrder replaces in place by id only', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.upsertWorkspacePreserveOrder(makeWorkspace('b', '/b', { name: 'renamed' }));
    expect(store.workspaces.map((w) => w.id)).toEqual(['a', 'b']);
    expect(store.workspaces[1]!.name).toBe('renamed');
  });

  it('upsertWorkspacePreserveOrder keeps same-root entries with distinct ids separate', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    store.upsertWorkspacePreserveOrder(makeWorkspace('new-id', '/a'));
    expect(store.workspaces.map((w) => w.id)).toEqual(['new-id', 'a']);
  });

  it('upsertWorkspacePreserveOrder un-hides a re-added id and applies name overrides', () => {
    const store = workspacesStore();
    store.hiddenWorkspaceIds = ['w1'];
    memStorage.set(STORAGE_KEYS.workspaceNameOverridesById, JSON.stringify({ w1: 'My Proj' }));
    store.upsertWorkspacePreserveOrder(makeWorkspace('w1', 'c:\\foo'));
    expect(store.hiddenWorkspaceIds).toEqual([]);
    expect(loadHiddenWorkspaceIds()).toEqual([]);
    expect(store.workspaces[0]!.name).toBe('My Proj');
  });

  it('hideWorkspace records the id once and persists it', () => {
    const store = workspacesStore();
    store.hideWorkspace('a');
    store.hideWorkspace('a');
    expect(store.hiddenWorkspaceIds).toEqual(['a']);
    expect(loadHiddenWorkspaceIds()).toEqual(['a']);
  });

  it('removeWorkspaceEntries drops by id only, keeping same-root entries', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/r'), makeWorkspace('b', '/r'), makeWorkspace('c', '/c')];
    store.removeWorkspaceEntries('a', '/r');
    expect(store.workspaces.map((w) => w.id)).toEqual(['b', 'c']);
  });

  it('migrateActiveWorkspaceAfterRemoval falls back to the first visible workspace', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.workspaceOrder = ['b', 'a'];
    store.storedActiveWorkspaceId = 'gone';
    store.migrateActiveWorkspaceAfterRemoval();
    expect(store.storedActiveWorkspaceId).toBe('b');
    expect(loadActiveWorkspace()).toBe('b');
  });

  it('migrateActiveWorkspaceAfterRemoval clears storage when nothing remains', () => {
    const store = workspacesStore();
    memStorage.set(STORAGE_KEYS.activeWorkspace, 'gone');
    store.storedActiveWorkspaceId = 'gone';
    store.migrateActiveWorkspaceAfterRemoval();
    expect(store.storedActiveWorkspaceId).toBeNull();
    expect(loadActiveWorkspace()).toBeNull();
  });

  it('applyWorkspaceRename updates the matching entry only', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.applyWorkspaceRename('b', 'renamed');
    expect(store.workspaces.map((w) => w.name)).toEqual(['a', 'renamed']);
  });
});

describe('mergedWorkspaces wiring', () => {
  it('derives workspaces from session cwds and honors hidden ids', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    sessionsStore().setSessions([makeSession('s1', '2026-01-01T00:00:00.000Z', { cwd: '/derived' })]);
    expect(store.mergedWorkspaces.map((w) => w.id)).toEqual(['a', '/derived']);
    store.hiddenWorkspaceIds = ['/derived'];
    expect(store.mergedWorkspaces.map((w) => w.id)).toEqual(['a']);
  });

  it('workspaceIdForSession prefers the session workspaceId, then the registered root match', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    expect(store.workspaceIdForSession({ cwd: '/a', workspaceId: 'wm_1' })).toBe('wm_1');
    expect(store.workspaceIdForSession({ cwd: '/a' })).toBe('a');
    expect(store.workspaceIdForSession({ cwd: '/else', workspaceId: 'wd_1' })).toBe('wd_1');
    expect(store.workspaceIdForSession({ cwd: '/else' })).toBe('/else');
  });
});

describe('recency floor fold', () => {
  it('folds the pool max(updatedAt) per workspace and persists it', async () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    sessionsStore().setSessions([
      makeSession('s1', '2026-01-02T00:00:00.000Z', { cwd: '/a' }),
      makeSession('s2', '2026-01-03T00:00:00.000Z', { cwd: '/a' }),
      makeSession('s3', '2026-01-04T00:00:00.000Z', { cwd: '/a', archived: true }),
    ]);
    await nextTick();
    const expected = Date.parse('2026-01-03T00:00:00.000Z');
    expect(store.workspaceRecencyFloor).toEqual({ a: expected });
    expect(loadWorkspaceRecencyFloor()).toEqual({ a: expected });
  });

  it('never decreases the floor on later folds', async () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    store.workspaceRecencyFloor = { a: Date.parse('2026-01-05T00:00:00.000Z') };
    sessionsStore().setSessions([makeSession('s1', '2026-01-02T00:00:00.000Z', { cwd: '/a' })]);
    await nextTick();
    expect(store.workspaceRecencyFloor.a).toBe(Date.parse('2026-01-05T00:00:00.000Z'));
  });
});

describe('grouped pagination actions', () => {
  it('commitSessionGroupPagination replaces all three records without a prior', () => {
    const store = workspacesStore();
    store.sessionsLoadingMoreByWorkspace = { a: true };
    store.commitSessionGroupPagination(
      makeMapping({ a: { hasMore: true, cursor: 'cur-a', count: 5 } }),
    );
    expect(store.sessionsHasMoreByWorkspace).toEqual({ a: true });
    expect(store.sessionsCursorByWorkspace).toEqual({ a: 'cur-a' });
    expect(store.sessionsInitialCountByWorkspace).toEqual({ a: 5 });
  });

  it('commitSessionGroupPagination skips workspaces whose cursor moved since the prior mapping', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    const prior = makeMapping({
      a: { hasMore: true, cursor: 'cur-a' },
      b: { hasMore: true, cursor: 'cur-b' },
    });
    store.commitSessionGroupPagination(prior);
    store.sessionsCursorByWorkspace = { a: 'reanchored', b: 'cur-b' };
    store.commitSessionGroupPagination(
      makeMapping({
        a: { hasMore: false, cursor: 'cur-a2' },
        b: { hasMore: false, cursor: 'cur-b2' },
      }),
      prior,
    );
    expect(store.sessionsCursorByWorkspace).toEqual({ a: 'reanchored', b: 'cur-b2' });
    expect(store.sessionsHasMoreByWorkspace).toEqual({ a: true, b: false });
  });

  it('resetSessionGroupPagination clears all records', () => {
    const store = workspacesStore();
    store.commitSessionGroupPagination(makeMapping({ a: { hasMore: true, cursor: 'cur-a' } }));
    store.resetSessionGroupPagination();
    expect(store.sessionsHasMoreByWorkspace).toEqual({});
    expect(store.sessionsCursorByWorkspace).toEqual({});
    expect(store.sessionsInitialCountByWorkspace).toEqual({});
  });

  it('clearSessionsHasMore marks every known workspace fully loaded', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a'), makeWorkspace('b', '/b')];
    store.sessionsHasMoreByWorkspace = { a: true, stale: true };
    store.clearSessionsHasMore();
    expect(store.sessionsHasMoreByWorkspace).toEqual({ a: false, b: false });
  });

  it('per-key setters write single keys without replacing the records', () => {
    const store = workspacesStore();
    store.setSessionHasMore('a', true);
    store.setSessionLoadingMore('a', true);
    store.setSessionCursor('a', 'cur-a');
    const hasMoreRef = store.sessionsHasMoreByWorkspace;
    store.setSessionHasMore('b', false);
    expect(store.sessionsHasMoreByWorkspace).toBe(hasMoreRef);
    expect(store.sessionsHasMoreByWorkspace).toEqual({ a: true, b: false });
    expect(store.sessionsLoadingMoreByWorkspace).toEqual({ a: true });
    expect(store.sessionsCursorByWorkspace).toEqual({ a: 'cur-a' });
  });
});

describe('loadWorkspaces', () => {
  beforeEach(() => {
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
  });

  const apiMock: Record<string, unknown> = {};

  it('loads the registry, applies name overrides and stores fs home', async () => {
    apiMock.listWorkspaces = vi.fn().mockResolvedValue([makeWorkspace('a', '/a')]);
    apiMock.getFsHome = vi.fn().mockResolvedValue({ home: '/Users/x', recentRoots: ['/a'] });
    memStorage.set(STORAGE_KEYS.workspaceNameOverridesById, JSON.stringify({ a: 'Overridden' }));
    const store = workspacesStore();
    await store.loadWorkspaces();
    expect(store.workspaces[0]!.name).toBe('Overridden');
    expect(store.fsHome).toBe('/Users/x');
    expect(store.recentRoots).toEqual(['/a']);
  });

  it('clears the registry when the daemon calls fail (derived workspaces still work)', async () => {
    apiMock.listWorkspaces = vi.fn().mockRejectedValue(new Error('down'));
    apiMock.getFsHome = vi.fn().mockRejectedValue(new Error('down'));
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('a', '/a')];
    await store.loadWorkspaces();
    expect(store.workspaces).toEqual([]);
  });

  it('keeps cached sessions on their disabled host after refreshing the available projects', async () => {
    const store = workspacesStore();
    const local = makeWorkspace('wm_local', '/ws');
    store.workspaces = [local, makeWorkspace('wm_remote', '/srv/project', { hostId: 'devbox' })];
    sessionsStore().setSessions([makeSession('s_remote', '2026-01-01T00:00:00.000Z', {
      workspaceId: 'wm_remote', cwd: '/srv/project', hostId: 'devbox',
    })]);
    hostsStore().applySnapshot([{ id: 'devbox', host: 'example.test', status: 'disconnected', enabled: false }]);
    apiMock.listWorkspaces = vi.fn().mockResolvedValue([local]);
    apiMock.getFsHome = vi.fn().mockResolvedValue({ home: '', recentRoots: [] });

    try {
      await store.loadWorkspaces();
      expect(store.workspaceById.get('wm_remote')?.hostId).toBe('devbox');
      expect(store.visibleWorkspaceIds.has('wm_remote')).toBe(false);
      expect(store.openWorkspaceDraft('wm_remote')).toBe(false);
    } finally {
      hostsStore().byId = {};
      hostsStore().loaded = false;
    }
  });

  it('keeps legacy local overrides when the registry request fails', async () => {
    apiMock.listWorkspaces = vi.fn().mockRejectedValue(new Error('down'));
    apiMock.getFsHome = vi.fn().mockResolvedValue({ home: '', recentRoots: [] });
    memStorage.set(STORAGE_KEYS.hiddenWorkspaces, JSON.stringify(['/a']));
    memStorage.set(STORAGE_KEYS.workspaceNameOverrides, JSON.stringify({ '/b': 'Bee' }));
    const store = workspacesStore();

    await store.loadWorkspaces();

    expect(memStorage.get(STORAGE_KEYS.hiddenWorkspaces)).toBe(JSON.stringify(['/a']));
    expect(memStorage.get(STORAGE_KEYS.workspaceNameOverrides)).toBe(JSON.stringify({ '/b': 'Bee' }));
    expect(loadHiddenWorkspaceIds()).toEqual([]);
    expect(loadWorkspaceNameOverridesById()).toEqual({});
  });

  it('migrates legacy root-keyed hidden list and name overrides to workspace ids once', async () => {
    apiMock.listWorkspaces = vi.fn().mockResolvedValue([
      makeWorkspace('wd_a', '/a'),
      makeWorkspace('wm_b', '/b'),
    ]);
    apiMock.getFsHome = vi.fn().mockResolvedValue({ home: '', recentRoots: [] });
    memStorage.set(STORAGE_KEYS.hiddenWorkspaces, JSON.stringify(['/a', '/gone']));
    memStorage.set(
      STORAGE_KEYS.workspaceNameOverrides,
      JSON.stringify({ '/b': 'Bee', '/gone': 'Lost' }),
    );
    const store = workspacesStore();

    await store.loadWorkspaces();

    expect(store.hiddenWorkspaceIds).toEqual(['wd_a']);
    expect(loadHiddenWorkspaceIds()).toEqual(['wd_a']);
    expect(loadWorkspaceNameOverridesById()).toEqual({ wm_b: 'Bee' });
    expect(store.workspaces.find((w) => w.id === 'wm_b')!.name).toBe('Bee');
    expect(memStorage.has(STORAGE_KEYS.hiddenWorkspaces)).toBe(false);
    expect(memStorage.has(STORAGE_KEYS.workspaceNameOverrides)).toBe(false);

    memStorage.set(STORAGE_KEYS.hiddenWorkspaces, JSON.stringify(['/b']));
    store.hiddenWorkspaceIds = ['wd_a'];
    apiMock.listWorkspaces = vi.fn().mockResolvedValue([makeWorkspace('wm_b', '/b')]);
    await store.loadWorkspaces();
    expect(loadHiddenWorkspaceIds()).toEqual(['wd_a', 'wm_b']);
  });
});


describe('workspaces store session orchestration', () => {
  const apiMock: Record<string, unknown> = {};
  const hooks = {
    selectSession: vi.fn(async () => {}),
    writeSessionUrl: vi.fn(),
    setMainView: vi.fn(),
    setSessionLoading: vi.fn(),
  };

  beforeEach(() => {
    for (const mock of Object.values(apiMock)) mock.mockReset();
    for (const mock of Object.values(hooks)) mock.mockClear();
    setWorkspacesHooks(hooks);
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
  });

  afterEach(() => {
    setWorkspacesHooks(null);
    resetKimiClientDeps();
  });

  it('openWorkspace selects the most recent session of the workspace', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wd_1', '/ws')];
    sessionsStore().setSessions([
      makeSession('s1', '2026-01-02T00:00:00.000Z'),
      makeSession('s2', '2026-01-01T00:00:00.000Z'),
    ]);

    store.openWorkspace('wd_1');

    expect(store.storedActiveWorkspaceId).toBe('wd_1');
    expect(hooks.setMainView).toHaveBeenCalledWith('chat');
    expect(hooks.selectSession).toHaveBeenCalledWith('s1', { skipTrack: true });
  });

  it('openWorkspace clears the active session when the workspace has none', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wd_1', '/ws')];
    sessionsStore().setSessions([]);

    store.openWorkspace('wd_1');

    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(hooks.writeSessionUrl).toHaveBeenCalledWith(undefined, 'push');
    expect(hooks.selectSession).not.toHaveBeenCalled();
  });

  it('applyWorkspaceEvent upserts created and updated workspaces', () => {
    const store = workspacesStore();

    store.applyWorkspaceEvent({ type: 'workspaceCreated', workspace: makeWorkspace('wd_1', '/ws') });
    expect(store.workspaces).toHaveLength(1);

    store.applyWorkspaceEvent({
      type: 'workspaceUpdated',
      workspace: { ...makeWorkspace('wd_1', '/ws'), name: 'renamed' },
    });
    expect(store.workspaces).toHaveLength(1);
    expect(store.workspaces[0]!.name).toBe('renamed');
  });

  it('re-evaluates empty implicit visibility on workspace lifecycle events', () => {
    const store = workspacesStore();
    store.applyWorkspaceEvent({
      type: 'workspaceCreated',
      workspace: makeWorkspace('wd_empty', '/empty', { sessionCount: 0 }),
    });
    expect(store.workspacesView).toEqual([]);

    store.applyWorkspaceEvent({
      type: 'workspaceUpdated',
      workspace: makeWorkspace('wd_empty', '/empty', { sessionCount: 1 }),
    });
    expect(store.workspacesView.map((workspace) => workspace.id)).toEqual(['wd_empty']);

    store.applyWorkspaceEvent({
      type: 'workspaceUpdated',
      workspace: makeWorkspace('wd_empty', '/empty', { sessionCount: 0 }),
    });
    expect(store.workspacesView).toEqual([]);
  });

  it('applyWorkspaceEvent deleted migrates the active workspace and clears the session', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wd_1', '/ws'), makeWorkspace('wd_2', '/ws2')];
    store.storedActiveWorkspaceId = 'wd_1';
    sessionsStore().setSessions([makeSession('s1', '2026-01-02T00:00:00.000Z')]);
    sessionsStore().setActiveSessionId('s1');

    store.applyWorkspaceEvent({ type: 'workspaceDeleted', workspaceId: 'wd_1', root: '/ws' });

    expect(store.workspaces.map((w) => w.id)).toEqual(['wd_2']);
    expect(store.hiddenWorkspaceIds).toContain('wd_1');
    expect(store.storedActiveWorkspaceId).toBe('wd_2');
    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(hooks.setSessionLoading).toHaveBeenCalledWith(false);
    expect(hooks.writeSessionUrl).toHaveBeenCalledWith(undefined, 'replace');
  });

  it('applyWorkspaceEvent deleted keeps the active workspace when another one is removed', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wd_1', '/ws'), makeWorkspace('wd_2', '/ws2')];
    store.storedActiveWorkspaceId = 'wd_1';
    sessionsStore().setSessions([makeSession('s1', '2026-01-02T00:00:00.000Z')]);
    sessionsStore().setActiveSessionId('s1');

    store.applyWorkspaceEvent({ type: 'workspaceDeleted', workspaceId: 'wd_2', root: '/ws2' });

    expect(store.storedActiveWorkspaceId).toBe('wd_1');
    expect(sessionsStore().activeSessionId).toBe('s1');
    expect(hooks.writeSessionUrl).not.toHaveBeenCalled();
  });

  it('clearActiveSession clears and writes the URL', () => {
    sessionsStore().setActiveSessionId('s1');

    workspacesStore().clearActiveSession();

    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(hooks.setMainView).toHaveBeenCalledWith('chat');
    expect(hooks.writeSessionUrl).toHaveBeenCalledWith(undefined, 'push');
  });

  it('openWorkspaceDraft sets the entry, selects the workspace, and clears the session', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wd_1', '/ws')];
    sessionsStore().setActiveSessionId('s1');

    sessionsStore().setSessions([makeSession('recent', '2026-01-02T00:00:00.000Z', { workspaceId: 'wd_1' })]);

    store.openWorkspaceDraft('wd_1', { entry: 'newChat' });

    expect(store.storedActiveWorkspaceId).toBe('wd_1');
    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(hooks.selectSession).not.toHaveBeenCalled();
    expect(hooks.writeSessionUrl).toHaveBeenCalledWith(undefined, 'push');
  });

  it('openWorkspaceDraft refuses projects on a host that is disabled or failed to connect', () => {
    const store = workspacesStore();
    store.workspaces = [
      makeWorkspace('wd_local', '/ws'),
      makeWorkspace('wd_failed', '/srv/a', { hostId: 'broken' }),
      makeWorkspace('wd_disabled', '/srv/b', { hostId: 'paused' }),
    ];
    store.storedActiveWorkspaceId = 'wd_local';
    hostsStore().loaded = true;
    hostsStore().byId = {
      broken: { id: 'broken', host: 'broken.test', status: 'disconnected', connectError: 'Connection refused' },
      paused: { id: 'paused', host: 'paused.test', status: 'disconnected', enabled: false },
    };

    expect(store.openWorkspaceDraft('wd_failed', { entry: 'newChat' })).toBe(false);
    expect(store.openWorkspaceDraft('wd_disabled', { entry: 'workspace' })).toBe(false);
    expect(store.storedActiveWorkspaceId).toBe('wd_local');
    expect(store.openWorkspaceDraft('wd_local')).toBe(true);
    hostsStore().byId = {};
    hostsStore().loaded = false;
  });

  it('exits the active session and clears host state when a host is disabled or removed, but stays on connection failure', async () => {
    const store = workspacesStore();
    store.workspaces = [
      makeWorkspace('wd_remote', '/srv/a', { hostId: 'devbox' }),
      makeWorkspace('wd_local', '/ws'),
    ];
    store.storedActiveWorkspaceId = 'wd_remote';
    sessionsStore().setSessions([makeSession('s_remote', '2026-01-02T00:00:00.000Z', { workspaceId: 'wd_remote' })]);
    sessionsStore().setActiveSessionId('s_remote');
    hostsStore().applySnapshot([{ id: 'devbox', host: 'dev.test', status: 'ready' }]);

    hostsStore().applySnapshot([{ id: 'devbox', host: 'dev.test', status: 'disconnected', connectError: 'Connection refused' }]);
    expect(sessionsStore().activeSessionId).toBe('s_remote');
    expect(store.storedActiveWorkspaceId).toBe('wd_remote');

    hostsStore().applySnapshot([{ id: 'devbox', host: 'dev.test', status: 'disconnected', enabled: false }]);
    store.handleUnavailableHosts(['devbox']);
    expect(sessionsStore().activeSessionId).toBeUndefined();
    expect(store.storedActiveWorkspaceId).toBe('wd_local');
    expect(store.workspaces.map((w) => w.id)).toEqual(['wd_remote', 'wd_local']);
    await expect(store.ensureWorkspaceTrust('wd_remote')).resolves.toEqual({ status: 'aborted' });
    expect(hooks.setSessionLoading).toHaveBeenCalledWith(false);
    expect(hooks.writeSessionUrl).toHaveBeenCalledWith(undefined, 'replace');

    sessionsStore().setSessions([]);
    store.workspaces = [makeWorkspace('wd_remote', '/srv/a', { hostId: 'devbox' })];
    store.storedActiveWorkspaceId = 'wd_remote';
    store.trustByWorkspaceId = { wd_remote: true };
    store.trustErrorByWorkspaceId = {
      wd_remote: { operation: 'read', message: 'not configured', originalError: new Error('not configured') },
    };
    store.setSessionCursor('wd_remote', 's_remote');
    store.setSessionHasMore('wd_remote', true);
    hostsStore().applySnapshot([{ id: 'devbox', host: 'dev.test', status: 'ready' }]);
    expect(store.activeWorkspaceId).toBe('wd_remote');

    hostsStore().applySnapshot([]);
    expect(store.removeHostWorkspaces(['devbox'])).toEqual(['wd_remote']);
    expect(store.workspaces).toEqual([]);
    expect(store.storedActiveWorkspaceId).toBeNull();
    expect(store.activeWorkspaceId).toBeNull();
    expect(store.trustByWorkspaceId.wd_remote).toBeUndefined();
    expect(store.trustErrorByWorkspaceId.wd_remote).toBeUndefined();
    expect(store.sessionsCursorByWorkspace.wd_remote).toBeUndefined();
    expect(store.sessionsHasMoreByWorkspace.wd_remote).toBeUndefined();

    store.workspaces = [
      makeWorkspace('wd_local', '/local'),
      makeWorkspace('wd_other', '/srv/b', { hostId: 'otherbox' }),
    ];
    store.storedActiveWorkspaceId = 'wd_local';
    store.trustErrorByWorkspaceId = {
      wd_other: { operation: 'read', message: 'not configured', originalError: new Error('not configured') },
    };
    store.trustLoadingByWorkspaceId = { wd_other: true };
    hostsStore().applySnapshot([{ id: 'otherbox', host: 'other.test', status: 'ready' }]);
    expect(store.activeWorkspaceId).toBe('wd_local');

    hostsStore().applySnapshot([]);
    expect(store.removeHostWorkspaces(['otherbox'])).toEqual(['wd_other']);
    expect(store.workspaces.map((w) => w.id)).toEqual(['wd_local']);
    expect(store.activeWorkspaceId).toBe('wd_local');
    expect(store.trustErrorByWorkspaceId.wd_other).toBeUndefined();
    expect(store.trustLoadingByWorkspaceId.wd_other).toBe(false);
    hostsStore().byId = {};
    hostsStore().loaded = false;
  });

  it('uses explicit workspace ids before root when checking session ownership', () => {
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/ws'), makeWorkspace('wm_2', '/ws')];
    const explicit = makeSession('explicit', '2026-01-01T00:00:00.000Z', { workspaceId: 'wm_2' });
    const legacy = makeSession('legacy', '2026-01-01T00:00:00.000Z');

    expect(store.sessionBelongsToWorkspace(explicit, 'wm_1')).toBe(false);
    expect(store.sessionBelongsToWorkspace(explicit, 'wm_2')).toBe(true);
    expect(store.sessionBelongsToWorkspace(legacy, 'wm_1')).toBe(true);
    expect(store.sessionBelongsToWorkspace(legacy, 'wm_2')).toBe(false);
  });

  it('opens the most recent workspace instead of the first same-root match', () => {
    const store = workspacesStore();
    store.workspaces = [
      makeWorkspace('wm_1', '/ws', { lastOpenedAt: '2026-01-01T00:00:00.000Z' }),
      makeWorkspace('wm_2', '/ws', { lastOpenedAt: '2026-01-02T00:00:00.000Z' }),
      makeWorkspace('wm_remote', '/ws', { hostId: 'devbox', lastOpenedAt: '2026-03-01T00:00:00.000Z' }),
    ];

    expect(store.openMostRecentWorkspaceByRoot('/ws')?.id).toBe('wm_2');
    store.workspaceRecencyFloor = { wm_1: Date.parse('2026-02-01T00:00:00.000Z') };
    expect(store.openMostRecentWorkspaceByRoot('/ws')?.id).toBe('wm_1');
  });

  it('deleteWorkspace keeps the active session of a same-root sibling', async () => {
    apiMock.deleteWorkspace = vi.fn().mockResolvedValue({ deleted: true });
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/ws'), makeWorkspace('wm_2', '/ws')];
    store.storedActiveWorkspaceId = 'wm_2';
    sessionsStore().setSessions([
      makeSession('sibling', '2026-01-01T00:00:00.000Z', { workspaceId: 'wm_2' }),
    ]);
    sessionsStore().setActiveSessionId('sibling');

    await store.deleteWorkspace('wm_1');

    expect(sessionsStore().activeSessionId).toBe('sibling');
    expect(store.storedActiveWorkspaceId).toBe('wm_2');
    expect(store.workspaces.map((workspace) => workspace.id)).toEqual(['wm_2']);
  });
});

describe('createWorkspace', () => {
  const apiMock: Record<string, unknown> = {};
  const hooks = {
    selectSession: vi.fn(async () => {}),
    writeSessionUrl: vi.fn(),
    setMainView: vi.fn(),
    setSessionLoading: vi.fn(),
  };

  beforeEach(() => {
    for (const mock of Object.values(hooks)) mock.mockClear();
    setWorkspacesHooks(hooks);
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
    workspacesStore().resetCreateWorkspaceAttempt();
  });

  afterEach(() => {
    setWorkspacesHooks(null);
    resetKimiClientDeps();
    workspacesStore().resetCreateWorkspaceAttempt();
  });

  it('posts root, additionalDirs and an idempotency key, then opens a draft', async () => {
    const created = makeWorkspace('wm_1', '/a', { additionalDirs: ['/b', '/c'] });
    const addWorkspace = vi.fn().mockResolvedValue(created);
    apiMock.addWorkspace = addWorkspace;
    const store = workspacesStore();

    const ws = await store.createWorkspace({ paths: ['/a', '/b', '/c'], name: 'Team' });

    expect(ws).toEqual(created);
    expect(addWorkspace).toHaveBeenCalledTimes(1);
    expect(addWorkspace.mock.calls[0]![0]).toEqual({
      root: '/a',
      additionalDirs: ['/b', '/c'],
      name: 'Team',
      idempotencyKey: expect.any(String),
    });
    expect(store.workspaces.map((w) => w.id)).toEqual(['wm_1']);
    expect(store.storedActiveWorkspaceId).toBe('wm_1');
    expect(hooks.writeSessionUrl).toHaveBeenCalledWith(undefined, 'push');
  });

  it('reuses the idempotency key only for the same unfinished create attempt', async () => {
    const created = makeWorkspace('wm_retry', '/a', { additionalDirs: [] });
    const addWorkspace = vi.fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValue(created);
    apiMock.addWorkspace = addWorkspace;
    const store = workspacesStore();

    expect(await store.createWorkspace({ paths: ['/a'], name: 'Team' })).toBeUndefined();
    expect(await store.createWorkspace({ paths: ['/a'], name: 'Team' })).toEqual(created);
    await store.createWorkspace({ paths: ['/b'], name: 'Team' });
    store.resetCreateWorkspaceAttempt();
    await store.createWorkspace({ paths: ['/a'], name: 'Team' });

    const keys = addWorkspace.mock.calls.map((call) => call[0].idempotencyKey);
    expect(keys).toHaveLength(4);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[0]);
    expect(keys[3]).not.toBe(keys[2]);
  });

  it('omits additionalDirs for a single path and skips the daemon for empty paths', async () => {
    const created = makeWorkspace('wm_2', '/a');
    const addWorkspace = vi.fn().mockResolvedValue(created);
    apiMock.addWorkspace = addWorkspace;
    const store = workspacesStore();

    await store.createWorkspace({ paths: ['/a'] });

    expect(addWorkspace.mock.calls[0]![0]).toEqual({
      root: '/a',
      idempotencyKey: expect.any(String),
    });

    addWorkspace.mockClear();
    const ws = await store.createWorkspace({ paths: [] });
    expect(ws).toBeUndefined();
    expect(addWorkspace).not.toHaveBeenCalled();
  });

  it('reports daemon failures and returns undefined', async () => {
    const failure = vi.spyOn(warningsStore(), 'pushOperationFailure');
    apiMock.addWorkspace = vi.fn().mockRejectedValue(new Error('boom'));
    const store = workspacesStore();

    const ws = await store.createWorkspace({ paths: ['/a'] });

    expect(ws).toBeUndefined();
    expect(failure).toHaveBeenCalledWith('createWorkspace', expect.any(Error), { message: undefined });
    failure.mockRestore();
  });

  it('reports duplicate directories with the localized path-aware message', async () => {
    const failure = vi.spyOn(warningsStore(), 'pushOperationFailure');
    const translate = vi.fn((key: string) => key);
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: translate });
    const error = new DaemonApiError({
      code: 40006,
      msg: 'Duplicate source folder: /b',
      requestId: 'r',
      details: [{ path: 'additional_dirs.1', directory: '/b' }],
    });
    apiMock.addWorkspace = vi.fn().mockRejectedValue(error);

    const ws = await workspacesStore().createWorkspace({ paths: ['/a', '/b', '/b/'] });

    expect(ws).toBeUndefined();
    expect(failure).toHaveBeenCalledWith('createWorkspace', error, { message: 'workspace.dialog.duplicateDir' });
    expect(translate).toHaveBeenCalledWith('workspace.dialog.duplicateDir', { directory: '/b' });
    failure.mockRestore();
  });
});

describe('saveWorkspace', () => {
  const apiMock: Record<string, unknown> = {};

  beforeEach(() => {
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
  });

  afterEach(() => {
    resetKimiClientDeps();
    setProductTracker(noopProductTracker);
  });

  it('patches name and additionalDirs, upserts the result and clears the override', async () => {
    memStorage.set(STORAGE_KEYS.workspaceNameOverridesById, JSON.stringify({ wm_1: 'Draft' }));
    const updated = makeWorkspace('wm_1', '/a', { name: 'Team', additionalDirs: ['/b'] });
    const updateWorkspace = vi.fn().mockResolvedValue(updated);
    apiMock.updateWorkspace = updateWorkspace;
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a', { name: 'Old' })];

    const ok = await store.saveWorkspace({ id: 'wm_1', name: 'Team', additionalDirs: ['/b'] });

    expect(ok).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith('wm_1', {
      name: 'Team',
      additionalDirs: ['/b'],
    });
    expect(store.workspaces[0]).toEqual(updated);
    expect(loadWorkspaceNameOverridesById()).toEqual({});
  });

  it('registers a newly added directory before promoting it to primary', async () => {
    const staged = makeWorkspace('wm_1', '/a', { name: 'Old', additionalDirs: ['/b'] });
    const promoted = makeWorkspace('wm_1', '/b', { name: 'Old', additionalDirs: ['/a'] });
    const updated = makeWorkspace('wm_1', '/b', { name: 'New', additionalDirs: ['/a'] });
    const updateWorkspace = vi.fn()
      .mockResolvedValueOnce(staged)
      .mockResolvedValueOnce(updated);
    const setWorkspacePrimary = vi.fn().mockResolvedValue(promoted);
    apiMock.updateWorkspace = updateWorkspace;
    apiMock.setWorkspacePrimary = setWorkspacePrimary;
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a', { name: 'Old', additionalDirs: [] })];

    const ok = await store.saveWorkspace({
      id: 'wm_1',
      name: 'New',
      additionalDirs: ['/a'],
      primary: '/b',
    });

    expect(ok).toBe(true);
    expect(updateWorkspace).toHaveBeenNthCalledWith(1, 'wm_1', { additionalDirs: ['/b'] });
    expect(setWorkspacePrimary).toHaveBeenCalledWith('wm_1', '/b');
    expect(updateWorkspace).toHaveBeenNthCalledWith(2, 'wm_1', {
      name: 'New',
      additionalDirs: ['/a'],
    });
    expect(updateWorkspace.mock.invocationCallOrder[0]).toBeLessThan(setWorkspacePrimary.mock.invocationCallOrder[0]!);
    expect(setWorkspacePrimary.mock.invocationCallOrder[0]).toBeLessThan(updateWorkspace.mock.invocationCallOrder[1]!);
    expect(store.workspaces[0]).toEqual(updated);
  });

  it('does not pre-register an existing additional directory before promoting it', async () => {
    const promoted = makeWorkspace('wm_1', '/b', { name: 'Old', additionalDirs: ['/a'] });
    const updated = makeWorkspace('wm_1', '/b', { name: 'New', additionalDirs: ['/a'] });
    const updateWorkspace = vi.fn().mockResolvedValue(updated);
    const setWorkspacePrimary = vi.fn().mockResolvedValue(promoted);
    apiMock.updateWorkspace = updateWorkspace;
    apiMock.setWorkspacePrimary = setWorkspacePrimary;
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a', { name: 'Old', additionalDirs: ['/b'] })];

    const ok = await store.saveWorkspace({
      id: 'wm_1',
      name: 'New',
      additionalDirs: ['/a'],
      primary: '/b',
    });

    expect(ok).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledOnce();
    expect(updateWorkspace).toHaveBeenCalledWith('wm_1', {
      name: 'New',
      additionalDirs: ['/a'],
    });
    expect(setWorkspacePrimary).toHaveBeenCalledWith('wm_1', '/b');
    expect(setWorkspacePrimary.mock.invocationCallOrder[0]).toBeLessThan(updateWorkspace.mock.invocationCallOrder[0]!);
  });

  it('falls back to an id-keyed local override on 40410 rename-only', async () => {
    const updateWorkspace = vi.fn().mockRejectedValue(
      new DaemonApiError({ code: 40410, msg: 'workspace not found', requestId: 'r' }),
    );
    apiMock.updateWorkspace = updateWorkspace;
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a', { name: 'Old' })];

    const ok = await store.saveWorkspace({ id: 'wm_1', name: 'New' });

    expect(ok).toBe(true);
    expect(updateWorkspace).toHaveBeenCalledWith('wm_1', { name: 'New' });
    expect(store.workspaces[0]!.name).toBe('New');
    expect(loadWorkspaceNameOverridesById()).toEqual({ wm_1: 'New' });
  });

  it('reports 40410 instead of falling back when additionalDirs are included', async () => {
    const failure = vi.spyOn(warningsStore(), 'pushOperationFailure');
    apiMock.updateWorkspace = vi.fn().mockRejectedValue(
      new DaemonApiError({ code: 40410, msg: 'workspace not found', requestId: 'r' }),
    );
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a', { name: 'Old' })];

    const ok = await store.saveWorkspace({ id: 'wm_1', name: 'New', additionalDirs: ['/b'] });

    expect(ok).toBe(false);
    expect(failure).toHaveBeenCalledWith('saveWorkspace', expect.any(DaemonApiError), { message: undefined });
    expect(loadWorkspaceNameOverridesById()).toEqual({});
    expect(store.workspaces[0]!.name).toBe('Old');
    failure.mockRestore();
  });

  it('reports duplicate directories with the localized path-aware message', async () => {
    const failure = vi.spyOn(warningsStore(), 'pushOperationFailure');
    const translate = vi.fn((key: string) => key);
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: translate });
    const error = new DaemonApiError({
      code: 40006,
      msg: 'Duplicate source folder: /b',
      requestId: 'r',
      details: [{ path: 'additional_dirs.0', directory: '/b' }],
    });
    apiMock.updateWorkspace = vi.fn().mockRejectedValue(error);
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a')];

    const ok = await store.saveWorkspace({ id: 'wm_1', additionalDirs: ['/b', '/b/'] });

    expect(ok).toBe(false);
    expect(failure).toHaveBeenCalledWith('saveWorkspace', error, { message: 'workspace.dialog.duplicateDir' });
    expect(translate).toHaveBeenCalledWith('workspace.dialog.duplicateDir', { directory: '/b' });
    failure.mockRestore();
  });

  it('tracks project-config and manually added directories with distinct sources', async () => {
    const trackMock = vi.fn();
    setProductTracker({ track: trackMock });
    const updated = makeWorkspace('wm_1', '/a', { additionalDirs: ['/b', '/c', '/d'] });
    apiMock.updateWorkspace = vi.fn().mockResolvedValue(updated);
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_1', '/a')];

    expect(await store.saveWorkspace({
      id: 'wm_1',
      additionalDirs: ['/b', '/c', '/d'],
      projectConfigDirs: ['/b', '/c'],
    })).toBe(true);

    expect(trackMock.mock.calls).toEqual([
      ['workspace_dir_added', { source: 'project-config' }],
      ['workspace_dir_added', { source: 'project-config' }],
      ['workspace_dir_added', { source: 'registry' }],
    ]);
  });

  it('searches one root on the picked host and resolves relative directory results', async () => {
    const controller = new AbortController();
    const hostApi = { suggestFilesAtRoots: vi.fn() };
    apiMock.deviceApi = vi.fn(() => hostApi);
    hostApi.suggestFilesAtRoots.mockResolvedValue({
      items: [
        { path: 'apps/frontend', name: 'frontend', kind: 'directory' },
        { path: 'apps/frontend/index.ts', name: 'index.ts', kind: 'file' },
        { path: '/srv/backend', name: 'backend', kind: 'directory' },
      ],
      truncated: false,
    });

    await expect(workspacesStore().searchFs('/srv/project', 'front', controller.signal, 'devbox')).resolves.toEqual([
      { path: '/srv/project/apps/frontend', label: 'apps/frontend' },
      { path: '/srv/backend', label: '/srv/backend' },
    ]);
    expect(apiMock.deviceApi).toHaveBeenCalledExactlyOnceWith('devbox');
    expect(hostApi.suggestFilesAtRoots).toHaveBeenCalledExactlyOnceWith(['/srv/project'], {
      query: 'front',
      limit: 150,
      showHidden: true,
    }, { signal: controller.signal });
    delete apiMock.deviceApi;
  });

  it('resolves Windows search results with the root separator', async () => {
    apiMock.suggestFilesAtRoots = vi.fn().mockResolvedValue({
      items: [
        { path: 'apps/frontend', name: 'frontend', kind: 'directory' },
        { path: 'C:\\srv\\backend', name: 'backend', kind: 'directory' },
      ],
      truncated: false,
    });

    await expect(workspacesStore().searchFs('C:\\srv\\project', 'front', new AbortController().signal)).resolves.toEqual([
      { path: 'C:\\srv\\project\\apps\\frontend', label: 'apps/frontend' },
      { path: 'C:\\srv\\backend', label: 'C:\\srv\\backend' },
    ]);
  });

  it('surfaces remote browseFs errors while keeping local browseFs fallbacks quiet', async () => {
    const localApi = { browseFs: vi.fn().mockRejectedValue(new Error('local boom')) };
    const remoteApi = { browseFs: vi.fn().mockRejectedValue(new Error('ssh handshake failed')) };
    apiMock.deviceApi = vi.fn((hostId?: string) => (hostId === undefined ? localApi : remoteApi));

    await expect(workspacesStore().browseFs('/Users/x')).resolves.toEqual({ path: '', parent: null, entries: [] });
    await expect(workspacesStore().browseFs(undefined, undefined, 'devbox')).rejects.toThrow('ssh handshake failed');
    delete apiMock.deviceApi;
  });

  it.each([
    { kind: 'implicit' as const, expected: 'wd' },
    { kind: 'managed' as const, expected: 'wm' },
  ])('uses the registry $kind kind for removal telemetry', async ({ kind, expected }) => {
    const trackMock = vi.fn();
    setProductTracker({ track: trackMock });
    apiMock.deleteWorkspace = vi.fn().mockResolvedValue({ deleted: true });
    const store = workspacesStore();
    store.workspaces = [makeWorkspace('wm_review', '/a', { kind })];

    await store.deleteWorkspace('wm_review');

    expect(trackMock).toHaveBeenCalledWith('workspace_removed', {
      workspace_count: 0,
      kind: expected,
    });
  });

  it('forwards mkdirFs to the daemon API and surfaces rejections', async () => {
    setKimiClientDeps({ api: () => apiMock as unknown as KimiWebApi, t: (key) => key });
    apiMock.mkdirFs = vi.fn().mockResolvedValueOnce({ path: '/Users/x/fresh' });
    const store = workspacesStore();

    await expect(store.mkdirFs('/Users/x/fresh')).resolves.toEqual({ path: '/Users/x/fresh' });
    expect(apiMock.mkdirFs).toHaveBeenCalledWith('/Users/x/fresh');

    const conflict = Object.assign(new Error('exists'), { name: 'DaemonApiError', code: 40919 });
    apiMock.mkdirFs = vi.fn().mockRejectedValueOnce(conflict);
    await expect(store.mkdirFs('/Users/x/fresh')).rejects.toBe(conflict);
  });

  it('routes home and project config requests to the target SSH host', async () => {
    const remoteApi = {
      getFsHome: vi.fn().mockResolvedValue({ home: '/home/ubuntu', recentRoots: ['/home/ubuntu/app'] }),
      getWorkspaceProjectConfigDirs: vi.fn().mockResolvedValue(['/home/ubuntu/shared']),
    };
    apiMock.deviceApi = vi.fn(() => remoteApi);
    const store = workspacesStore();

    await expect(store.getFsHome('devbox')).resolves.toEqual({ home: '/home/ubuntu', recentRoots: ['/home/ubuntu/app'] });
    await expect(store.fetchWorkspaceProjectConfigDirs('/home/ubuntu/app', 'devbox')).resolves.toEqual(['/home/ubuntu/shared']);
    expect(remoteApi.getWorkspaceProjectConfigDirs).toHaveBeenCalledExactlyOnceWith('/home/ubuntu/app');
    expect(apiMock.deviceApi).toHaveBeenCalledWith('devbox');
    delete apiMock.deviceApi;
  });

  it('uses offline removal copy for a missing host without exposing its id', () => {
    hostsStore().loaded = true;
    hostsStore().byId = {};
    workspacesStore().workspaces = [makeWorkspace('wm_gone', '/srv/app', { name: 'trainer', hostId: 'host-a1b2c3d4' })];
    const tr = (key: string, params?: Record<string, unknown>) => key === 'workspace.deletedHost' ? 'Removed host' : `${key}:${String(params?.device)}`;
    expect(workspacesStore().removeWorkspaceMessage('wm_gone', tr)).toBe('workspace.removeWorkspaceConfirmHostOffline:Removed host');
    hostsStore().loaded = false;
  });
});
