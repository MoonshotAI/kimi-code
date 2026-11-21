import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import {
  ISessionIndex,
  type SessionCountQuery,
  type SessionIndexStatus,
  type SessionListQuery,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import type { ImplicitDecision, ImplicitProject } from '#/app/project/implicitProject';
import { IProjectService } from '#/app/project/project';
import { IProjectAliases } from '#/app/projectAliases/projectAliases';
import type { ImplicitProjectId } from '#/_base/utils/workdir-slug';
import {
  IProjectSessions,
  RECENT_SESSIONS_LIMIT,
} from '#/app/projectSessions/projectSessions';
import { ProjectSessionsService } from '#/app/projectSessions/projectSessionsService';

class FakeSessionIndex implements ISessionIndex {
  readonly _serviceBrand: undefined;
  lastListQuery: SessionListQuery | undefined;
  readonly listQueries: SessionListQuery[] = [];
  lastCountQuery: SessionCountQuery | undefined;
  items: readonly SessionSummary[] = [];
  countResult = 0;

  async prepare(): Promise<SessionIndexStatus> {
    return this.status();
  }

  status(): SessionIndexStatus {
    return { state: 'uninitialized', degradedCount: 0 };
  }

  async listRecent(query: SessionListQuery) {
    this.lastListQuery = query;
    this.listQueries.push(query);
    const scoped = this.items.filter((item) =>
      (query.workspaceIds === undefined || query.workspaceIds.includes(item.workspaceId)) &&
      (query.includeArchived === true || !item.archived),
    );
    const start = query.before === undefined ? 0 : scoped.findIndex((item) => item.id === query.before) + 1;
    const window = scoped.slice(start);
    if (query.limit === undefined) return { items: window };
    const kept = window.slice(0, query.limit);
    return { items: kept, nextCursor: window.length > query.limit ? kept.at(-1)!.id : undefined };
  }

  async get(_id: string): Promise<SessionSummary | undefined> {
    return undefined;
  }

  async count(query: SessionCountQuery): Promise<number> {
    this.lastCountQuery = query;
    return this.countResult;
  }

  async remove(_id: string): Promise<void> {}
}

class FakeWorkspaceAliases implements IProjectAliases {
  readonly _serviceBrand: undefined;
  aliases: Record<string, readonly string[]> = {};

  resolveAliasIds(id: string): Promise<readonly string[]> {
    return Promise.resolve(this.aliases[id] ?? [id]);
  }
}

class FakeWorkspaceService {
  readonly _serviceBrand: undefined;
  decision: ImplicitDecision = { kind: 'create', rule: 'own', id: 'wd_new' as ImplicitProjectId, root: '/new' };
  readonly peeked: string[] = [];

  peekImplicit(dir: string): Promise<ImplicitDecision> {
    this.peeked.push(dir);
    return Promise.resolve(this.decision);
  }
}

function implicitProject(id: string, root: string): ImplicitProject {
  return { id, root, name: root, kind: 'implicit', additionalDirs: [], createdAt: 0, lastOpenedAt: 0 };
}

describe('WorkspaceSessionsService', () => {
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IProjectSessions,
      ProjectSessionsService,
      ScopeActivation.OnDemand,
      'workspaceSessions',
    );
  });

  afterEach(() => {
    currentHost?.dispose();
    currentHost = undefined;
  });

  function build(): {
    sessions: IProjectSessions;
    index: FakeSessionIndex;
    aliases: FakeWorkspaceAliases;
    workspaces: FakeWorkspaceService;
  } {
    const index = new FakeSessionIndex();
    const aliases = new FakeWorkspaceAliases();
    const workspaces = new FakeWorkspaceService();
    const host = createScopedTestHost([
      stubPair(ISessionIndex, index),
      stubPair(IProjectAliases, aliases),
      stubPair(IProjectService, workspaces as unknown as IProjectService),
    ]);
    currentHost = host;
    return { sessions: host.app.accessor.get(IProjectSessions), index, aliases, workspaces };
  }

  function placed(
    id: string,
    workspaceId: string,
    updatedAt: number,
    placement: { readonly cwd?: string; readonly environmentId?: string; readonly environmentCwd?: string },
  ): SessionSummary {
    return { ...summary(id, workspaceId, updatedAt), ...placement };
  }

  function summary(id: string, workspaceId: string, updatedAt: number): SessionSummary {
    return { id, workspaceId, createdAt: updatedAt - 1, updatedAt, archived: false };
  }

  it('listRecent delegates with the folded alias set and the recent limit', async () => {
    const { sessions, index, aliases } = build();
    aliases.aliases['wd_abc'] = ['wd_abc', 'wd_abc_legacy'];

    await sessions.listRecent('wd_abc');

    expect(index.lastListQuery).toEqual({
      workspaceIds: ['wd_abc', 'wd_abc_legacy'],
      limit: RECENT_SESSIONS_LIMIT,
    });
    expect(RECENT_SESSIONS_LIMIT).toBe(20);
  });

  it('listRecent returns the index items for the workspace', async () => {
    const { sessions, index } = build();
    const items = [summary('s2', 'wd_abc', 200), summary('s1', 'wd_abc', 100)];
    index.items = items;

    await expect(sessions.listRecent('wd_abc')).resolves.toEqual(items);
  });

  it('listRecent returns an empty array when the workspace has no sessions', async () => {
    const { sessions } = build();

    await expect(sessions.listRecent('wd_empty')).resolves.toEqual([]);
  });

  it('count folds aliases and includes archived sessions', async () => {
    const { sessions, index, aliases } = build();
    aliases.aliases['wd_abc'] = ['wd_abc', 'wd_abc_legacy'];
    index.countResult = 3;

    await expect(sessions.count('wd_abc')).resolves.toBe(3);
    expect(index.lastCountQuery).toEqual({
      workspaceIds: ['wd_abc', 'wd_abc_legacy'],
      includeArchived: true,
    });
  });

  it('count returns 0 when the workspace has no sessions', async () => {
    const { sessions } = build();

    await expect(sessions.count('wd_empty')).resolves.toBe(0);
  });

  it('lists the sessions of a directory from its implicit project and alias buckets, newest first', async () => {
    const { sessions, index, aliases, workspaces } = build();
    workspaces.decision = { kind: 'reuse', rule: 'repo', project: implicitProject('wd_repo', '/repo') };
    aliases.aliases['wd_repo'] = ['wd_repo', 'wd_repo_alias'];
    index.items = [
      placed('other-worktree', 'wd_repo', 600, { cwd: '/repo-fix', environmentCwd: '/repo-fix' }),
      placed('old-following', 'wd_repo_alias', 500, { cwd: '/created-elsewhere' }),
      placed('pinned', 'wd_repo', 400, { cwd: '/repo', environmentCwd: '/repo' }),
      placed('subdirectory', 'wd_repo', 300, { cwd: '/repo/src', environmentCwd: '/repo/src' }),
      placed('remote-from-here', 'wd_repo', 200, { cwd: '/repo', environmentId: 'ssh', environmentCwd: '/srv/repo' }),
      placed('managed', 'wm_repo', 100, { cwd: '/repo', environmentCwd: '/repo' }),
    ];

    const page = await sessions.listForWorkdir('/repo');

    expect(workspaces.peeked).toEqual(['/repo']);
    expect(index.lastListQuery?.workspaceIds).toEqual(['wd_repo', 'wd_repo_alias']);
    expect(page).toEqual({ items: [index.items[1], index.items[2], index.items[4]] });
  });

  it('keeps the sessions of the main checkout and of a worktree apart', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { kind: 'reuse', rule: 'repo', project: implicitProject('wd_repo', '/repo') };
    index.items = [
      placed('in-worktree', 'wd_repo', 200, { environmentCwd: '/repo-fix' }),
      placed('in-main', 'wd_repo', 100, { environmentCwd: '/repo' }),
    ];

    expect((await sessions.listForWorkdir('/repo')).items.map((item) => item.id)).toEqual(['in-main']);
    expect((await sessions.listForWorkdir('/repo-fix')).items.map((item) => item.id)).toEqual(['in-worktree']);
  });

  it('compares Windows-shaped working directories by drive and separator independent identity', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { kind: 'reuse', rule: 'own', project: implicitProject('wd_app', 'C:\\Work\\App') };
    index.items = [
      placed('pinned', 'wd_app', 200, { environmentCwd: 'c:/work/app/' }),
      placed('old-following', 'wd_app', 100, { cwd: 'C:\\Other' }),
    ];

    const page = await sessions.listForWorkdir('C:\\Work\\App');

    expect(page.items.map((item) => item.id)).toEqual(['pinned', 'old-following']);
  });

  it('pages through the index until the limit fills and continues from the returned cursor', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { kind: 'reuse', rule: 'own', project: implicitProject('wd_repo', '/repo') };
    index.items = Array.from({ length: 250 }, (_unused, position) =>
      placed(`s${String(position)}`, 'wd_repo', 1_000 - position, {
        environmentCwd: position % 100 === 99 ? '/repo' : '/repo-fix',
      }),
    );

    const first = await sessions.listForWorkdir('/repo', { limit: 1 });
    const second = await sessions.listForWorkdir('/repo', { limit: 1, before: first.nextCursor });
    const rest = await sessions.listForWorkdir('/repo', { limit: 5, before: second.nextCursor });

    expect(first).toEqual({ items: [index.items[99]], nextCursor: 's99' });
    expect(second).toEqual({ items: [index.items[199]], nextCursor: 's199' });
    expect(rest).toEqual({ items: [] });
    expect(index.listQueries.every((query) => query.limit !== undefined && query.limit > 1)).toBe(true);
  });

  it('reads the deterministic project of a directory that has no project yet and passes archived through', async () => {
    const { sessions, index } = build();
    index.items = [{ ...placed('archived', 'wd_new', 100, { environmentCwd: '/new' }), archived: true }];

    expect((await sessions.listForWorkdir('/new')).items).toEqual([]);
    expect((await sessions.listForWorkdir('/new', { includeArchived: true })).items.map((item) => item.id)).toEqual(['archived']);
    expect(index.lastListQuery).toMatchObject({ workspaceIds: ['wd_new'], includeArchived: true });
  });
});
