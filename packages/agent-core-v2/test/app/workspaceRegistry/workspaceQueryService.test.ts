import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { InstantiationType } from '#/_base/di/extensions';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ISessionIndex, type SessionListQuery, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import {
  IWorkspaceQueryService,
  RECENT_SESSIONS_LIMIT,
} from '#/app/workspaceRegistry/workspaceQuery';
import { WorkspaceQueryService } from '#/app/workspaceRegistry/workspaceQueryService';

class FakeSessionIndex implements ISessionIndex {
  readonly _serviceBrand: undefined;
  lastListQuery: SessionListQuery | undefined;
  items: readonly SessionSummary[] = [];

  async list(query: SessionListQuery) {
    this.lastListQuery = query;
    return { items: this.items };
  }

  async get(_id: string): Promise<SessionSummary | undefined> {
    return undefined;
  }

  async countActive(_workspaceIds: readonly string[]): Promise<number> {
    return 0;
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

  function build(): { query: IWorkspaceQueryService; index: FakeSessionIndex } {
    const index = new FakeSessionIndex();
    const host = createScopedTestHost([stubPair(ISessionIndex, index)]);
    currentHost = host;
    return { query: host.app.accessor.get(IWorkspaceQueryService), index };
  }

  function summary(id: string, workspaceId: string, updatedAt: number): SessionSummary {
    return { id, workspaceId, createdAt: updatedAt - 1, updatedAt, archived: false };
  }

  it('delegates to the session index with the workspace id and the recent limit', async () => {
    const { query, index } = build();

    await query.listRecentSessions('wd_abc');

    expect(index.lastListQuery).toEqual({
      workspaceIds: ['wd_abc'],
      limit: RECENT_SESSIONS_LIMIT,
    });
    expect(RECENT_SESSIONS_LIMIT).toBe(20);
  });

  it('returns the index items for the workspace', async () => {
    const { query, index } = build();
    const items = [summary('s2', 'wd_abc', 200), summary('s1', 'wd_abc', 100)];
    index.items = items;

    await expect(query.listRecentSessions('wd_abc')).resolves.toEqual(items);
  });

  it('returns an empty array when the workspace has no sessions', async () => {
    const { query } = build();

    await expect(query.listRecentSessions('wd_empty')).resolves.toEqual([]);
  });
});
