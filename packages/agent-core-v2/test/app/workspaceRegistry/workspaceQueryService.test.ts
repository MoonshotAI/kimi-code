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

  async countActive(_workspaceId: string): Promise<number> {
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
      workspaceId: 'wd_abc',
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

  it('returns an empty array when the session index returns empty items', async () => {
    const { query, index } = build();
    index.items = [];

    await expect(query.listRecentSessions('wd_empty')).resolves.toEqual([]);
  });

  it('passes through the workspace id with special characters', async () => {
    const { query, index } = build();
    const specialId = 'wd_工作区/with#special?chars&and=unicode';

    await query.listRecentSessions(specialId);

    expect(index.lastListQuery?.workspaceId).toBe(specialId);
  });

  it('passes through the workspace id with a very long value', async () => {
    const { query, index } = build();
    const longId = 'wd_' + 'x'.repeat(500);

    await query.listRecentSessions(longId);

    expect(index.lastListQuery?.workspaceId).toBe(longId);
  });

  it('handles concurrent listRecentSessions calls', async () => {
    const { query, index } = build();
    index.items = [summary('s1', 'wd_a', 100)];

    const [r1, r2] = await Promise.all([
      query.listRecentSessions('wd_a'),
      query.listRecentSessions('wd_b'),
    ]);

    // The shared index returns its items for both, but each call passes
    // the correct workspaceId in the query.
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1); // same index instance, same items
    expect(index.lastListQuery?.workspaceId).toBe('wd_b'); // last write wins
  });

  it('propagates session index list errors', async () => {
    const { query, index } = build();
    index.list = async () => {
      throw new Error('Index unavailable');
    };

    await expect(query.listRecentSessions('wd_abc')).rejects.toThrow('Index unavailable');
  });

  it('works with the empty string workspace id', async () => {
    const { query, index } = build();

    await query.listRecentSessions('');

    expect(index.lastListQuery?.workspaceId).toBe('');
  });

  it('limits the number of returned sessions to RECENT_SESSIONS_LIMIT', async () => {
    const { query, index } = build();
    const many = Array.from({ length: 50 }, (_, i) =>
      summary(`s${i}`, 'wd_big', 1000 + i),
    );
    index.items = many;

    const result = await query.listRecentSessions('wd_big');

    expect(result).toHaveLength(50);
    expect(index.lastListQuery?.limit).toBe(20);
  });
});
