/**
 * Scenario: workspace queries combine the catalog with persisted sessions.
 * Responsibilities: canonical roots, derived workspaces, legacy cwd fallback,
 * tombstones, archived counts, and recent-session filtering.
 * Wiring: real query service with in-memory contract fakes for registry/index.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import { ISessionIndex, type SessionListQuery, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import {
  IWorkspaceRegistry,
  type Workspace,
  type WorkspaceRegistrySnapshot,
  type WorkspaceUpdate,
} from '#/app/workspaceRegistry/workspaceRegistry';
import {
  IWorkspaceQueryService,
  RECENT_SESSIONS_LIMIT,
} from '#/app/workspaceRegistry/workspaceQuery';
import { WorkspaceQueryService } from '#/app/workspaceRegistry/workspaceQueryService';

class FakeSessionIndex implements ISessionIndex {
  readonly _serviceBrand: undefined;
  lastListQuery: SessionListQuery | undefined;
  items: readonly SessionSummary[] = [];

  async list(query: SessionListQuery): Promise<{ items: readonly SessionSummary[] }> {
    this.lastListQuery = query;
    const items = this.items.filter(
      (item) =>
        (query.workspaceId === undefined || item.workspaceId === query.workspaceId) &&
        (query.includeArchived === true || !item.archived),
    );
    return { items };
  }

  async get(_id: string): Promise<SessionSummary | undefined> {
    return undefined;
  }

  async countActive(_workspaceId: string): Promise<number> {
    return 0;
  }
}

class FakeWorkspaceRegistry implements IWorkspaceRegistry {
  readonly _serviceBrand: undefined;
  workspaces: readonly Workspace[] = [];
  readonly resolvedWorkspaces = new Map<string, Workspace>();
  readonly getCalls: string[] = [];
  readonly deletedIds = new Set<string>();
  readonly deletedRoots = new Map<string, string>();

  async list(): Promise<readonly Workspace[]> {
    return this.workspaces;
  }

  async snapshot(): Promise<WorkspaceRegistrySnapshot> {
    return {
      workspaces: this.workspaces,
      deletedWorkspaceIds: new Set(this.deletedIds),
      deletedWorkspaceRoots: new Map(this.deletedRoots),
    };
  }

  async get(id: string): Promise<Workspace | undefined> {
    this.getCalls.push(id);
    return this.resolvedWorkspaces.get(id) ?? this.workspaces.find((workspace) => workspace.id === id);
  }

  async createOrTouch(_root: string, _name?: string): Promise<Workspace> {
    throw new Error('not used');
  }

  async update(_id: string, _patch: WorkspaceUpdate): Promise<Workspace | undefined> {
    return undefined;
  }

  async delete(id: string): Promise<void> {
    this.deletedIds.add(id);
  }
}

describe('WorkspaceQueryService', () => {
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceQueryService,
      WorkspaceQueryService,
      InstantiationType.Delayed,
      'workspaceRegistry',
    );
  });

  afterEach(() => {
    currentHost?.dispose();
    currentHost = undefined;
  });

  function build(): {
    query: IWorkspaceQueryService;
    index: FakeSessionIndex;
    registry: FakeWorkspaceRegistry;
  } {
    const index = new FakeSessionIndex();
    const registry = new FakeWorkspaceRegistry();
    currentHost = createScopedTestHost([
      stubPair(ISessionIndex, index),
      stubPair(IWorkspaceRegistry, registry),
    ]);
    return {
      query: currentHost.app.accessor.get(IWorkspaceQueryService),
      index,
      registry,
    };
  }

  function summary(
    id: string,
    workspaceId: string,
    updatedAt: number,
    cwd?: string,
    archived = false,
  ): SessionSummary {
    return {
      id,
      workspaceId,
      cwd,
      createdAt: updatedAt - 10,
      updatedAt,
      archived,
    };
  }

  it('deduplicates aliases by normalized root and returns the canonical id', async () => {
    const { query, registry } = build();
    registry.workspaces = [
      {
        id: 'wd_legacy_deadbeef0000',
        root: '/work/../work/project',
        name: 'Project',
        createdAt: 1,
        lastOpenedAt: 2,
      },
      {
        id: encodeWorkDirKey('/work/project'),
        root: '/work/project',
        name: 'Project',
        createdAt: 1,
        lastOpenedAt: 3,
      },
    ];

    await expect(query.list()).resolves.toEqual([
      expect.objectContaining({
        id: encodeWorkDirKey('/work/project'),
        root: '/work/project',
        sessionCount: 0,
      }),
    ]);
  });

  it('uses the canonical representative and aggregates duplicate-root sessions', async () => {
    const { query, registry, index } = build();
    const root = '/work/duplicate-query';
    const canonicalId = encodeWorkDirKey(root);
    const alias = 'wd_duplicate_legacy_deadbeef0000';
    registry.workspaces = [
      { id: alias, root, name: 'Duplicate', createdAt: 1, lastOpenedAt: 2 },
      { id: canonicalId, root, name: 'Duplicate', createdAt: 1, lastOpenedAt: 3 },
    ];
    index.items = [
      summary('canonical-session', canonicalId, 200, root),
      summary('alias-session', alias, 100, root),
    ];

    await expect(query.list()).resolves.toEqual([
      expect.objectContaining({ id: canonicalId, sessionCount: 2 }),
    ]);
    await expect(query.get(alias)).resolves.toMatchObject({ id: canonicalId, root });
    await expect(query.listSessions(alias)).resolves.toHaveLength(2);
    await expect(query.countActiveSessions(canonicalId)).resolves.toBe(2);
  });

  it('keeps an alias-only representative while aggregating its root sessions', async () => {
    const { query, registry, index } = build();
    const root = '/work/alias-only-query';
    const canonicalId = encodeWorkDirKey(root);
    const alias = 'wd_alias_query_deadbeef0000';
    registry.workspaces = [
      { id: alias, root, name: 'Alias only', createdAt: 1, lastOpenedAt: 2 },
    ];
    index.items = [
      summary('alias-session', alias, 200, root),
      summary('canonical-session', canonicalId, 100, root),
    ];

    await expect(query.list()).resolves.toEqual([
      expect.objectContaining({ id: alias, sessionCount: 2 }),
    ]);
    await expect(query.get(canonicalId)).resolves.toMatchObject({ id: alias, root });
    await expect(query.listSessions(canonicalId)).resolves.toHaveLength(2);
  });

  it('derives an active workspace and excludes archived sessions from its count', async () => {
    const { query, index } = build();
    const workspaceId = encodeWorkDirKey('/work/derived');
    index.items = [
      summary('active', workspaceId, 200, '/work/derived'),
      summary('archived', workspaceId, 300, '/work/derived', true),
    ];

    await expect(query.list()).resolves.toEqual([
      expect.objectContaining({
        id: workspaceId,
        root: '/work/derived',
        sessionCount: 1,
        createdAt: 190,
        lastOpenedAt: 200,
      }),
    ]);
    expect(index.lastListQuery).toEqual({});
  });

  it('retains a legacy session without cwd by falling back to its workspace root', async () => {
    const { query, index, registry } = build();
    const root = '/work/legacy';
    const alias = 'wd_legacy_deadbeef0000';
    registry.workspaces = [
      { id: alias, root, name: 'Legacy', createdAt: 1, lastOpenedAt: 2 },
    ];
    index.items = [summary('legacy-session', alias, 100)];

    await expect(query.list()).resolves.toEqual([
      expect.objectContaining({
        id: alias,
        root,
        sessionCount: 1,
      }),
    ]);
    await expect(query.listSessions(encodeWorkDirKey(root))).resolves.toHaveLength(1);
  });

  it('resolves a physical legacy alias without cwd through the registry fallback', async () => {
    const { query, index, registry } = build();
    const root = '/work/legacy-physical';
    const canonicalId = encodeWorkDirKey(root);
    const alias = 'wd_legacy_physical_deadbeef0000';
    registry.workspaces = [
      { id: canonicalId, root, name: 'Legacy physical', createdAt: 1, lastOpenedAt: 2 },
    ];
    registry.resolvedWorkspaces.set(alias, {
      id: alias,
      root,
      name: 'Legacy physical',
      createdAt: 1,
      lastOpenedAt: 2,
    });
    index.items = [summary('legacy-1', alias, 100), summary('legacy-2', alias, 200)];

    await expect(query.list()).resolves.toEqual([
      expect.objectContaining({ id: canonicalId, root, sessionCount: 2 }),
    ]);
    expect(registry.getCalls).toEqual([alias]);
    await expect(query.listSessions(canonicalId)).resolves.toHaveLength(2);
    await expect(query.get(alias)).resolves.toMatchObject({ id: alias, root });
  });

  it('resolves an alias to its root before returning recent sessions', async () => {
    const { query, index, registry } = build();
    const root = '/work/recent';
    const alias = 'wd_legacy_deadbeef0000';
    registry.workspaces = [
      { id: alias, root, name: 'Recent', createdAt: 1, lastOpenedAt: 2 },
    ];
    index.items = [
      summary('s2', alias, 200, root),
      summary('s1', encodeWorkDirKey(root), 100, root),
      summary('other', encodeWorkDirKey('/work/other'), 300, '/work/other'),
    ];

    await expect(query.listRecentSessions(alias)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 's2' }), expect.objectContaining({ id: 's1' })]),
    );
    expect((await query.listRecentSessions(alias))).toHaveLength(2);
    expect(RECENT_SESSIONS_LIMIT).toBe(20);
  });

  it('hides a derived workspace after its root tombstone', async () => {
    const { query, index, registry } = build();
    index.items = [summary('s1', 'wd_unknown', 100, '/work/deleted')];
    registry.deletedRoots.set('wd_deleted', '/work/deleted');

    await expect(query.list()).resolves.toEqual([]);
    await expect(query.get('wd_unknown')).resolves.toBeUndefined();
  });

  it('hides a legacy alias when its canonical workspace id is tombstoned', async () => {
    const { query, index, registry } = build();
    const root = '/work/canonical-tombstone';
    const canonicalId = encodeWorkDirKey(root);
    const alias = 'wd_legacy_canonical_tombstone_deadbeef0000';
    registry.workspaces = [
      { id: alias, root, name: 'Legacy', createdAt: 1, lastOpenedAt: 2 },
    ];
    registry.deletedIds.add(canonicalId);
    index.items = [summary('legacy-session', alias, 100, root)];

    await expect(query.list()).resolves.toEqual([]);
    await expect(query.listSessions(alias)).resolves.toEqual([]);
    await expect(query.get(alias)).resolves.toBeUndefined();
  });
});
