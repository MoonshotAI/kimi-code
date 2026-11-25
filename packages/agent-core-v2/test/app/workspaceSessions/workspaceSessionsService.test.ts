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
import type { ImplicitDecision } from '#/app/workspace/implicitProject';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IWorkspaceAliases } from '#/app/workspaceAliases/workspaceAliases';
import {
  IWorkspaceSessions,
  RECENT_SESSIONS_LIMIT,
} from '#/app/workspaceSessions/workspaceSessions';
import { WorkspaceSessionsService } from '#/app/workspaceSessions/workspaceSessionsService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { HostFsError } from '#/os/interface/hostFsErrors';

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

class FakeWorkspaceAliases implements IWorkspaceAliases {
  readonly _serviceBrand: undefined;
  aliases: Record<string, readonly string[]> = {};

  resolveAliasIds(id: string): Promise<readonly string[]> {
    return Promise.resolve(this.aliases[id] ?? [id]);
  }
}

class FakeWorkspaceService {
  readonly _serviceBrand: undefined;
  decision: ImplicitDecision = { id: 'wd_new', root: '/new' };
  readonly peeked: string[] = [];

  peekImplicit(dir: string): Promise<ImplicitDecision> {
    this.peeked.push(dir);
    return Promise.resolve(this.decision);
  }
}

class FakeHostFileSystem {
  readonly _serviceBrand: undefined;
  readonly failures = new Map<string, HostFsError>();

  async stat(path: string) {
    const failure = this.failures.get(path);
    if (failure !== undefined) throw failure;
    return { isFile: false, isDirectory: true, size: 0 };
  }
}

describe('WorkspaceSessionsService', () => {
  let currentHost: ReturnType<typeof createScopedTestHost> | undefined;

  beforeEach(() => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IWorkspaceSessions,
      WorkspaceSessionsService,
      ScopeActivation.OnDemand,
      'workspaceSessions',
    );
  });

  afterEach(() => {
    currentHost?.dispose();
    currentHost = undefined;
  });

  function build(): {
    sessions: IWorkspaceSessions;
    index: FakeSessionIndex;
    aliases: FakeWorkspaceAliases;
    workspaces: FakeWorkspaceService;
    hostFs: FakeHostFileSystem;
  } {
    const index = new FakeSessionIndex();
    const aliases = new FakeWorkspaceAliases();
    const workspaces = new FakeWorkspaceService();
    const hostFs = new FakeHostFileSystem();
    const host = createScopedTestHost([
      stubPair(ISessionIndex, index),
      stubPair(IWorkspaceAliases, aliases),
      stubPair(IWorkspaceService, workspaces as unknown as IWorkspaceService),
      stubPair(IHostFileSystem, hostFs as unknown as IHostFileSystem),
    ]);
    currentHost = host;
    return { sessions: host.app.accessor.get(IWorkspaceSessions), index, aliases, workspaces, hostFs };
  }

  function summary(id: string, workspaceId: string, updatedAt: number, cwd?: string): SessionSummary {
    return { id, workspaceId, cwd, createdAt: updatedAt - 1, updatedAt, archived: false };
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
    workspaces.decision = { id: 'wd_repo', root: '/repo' };
    aliases.aliases['wd_repo'] = ['wd_repo', 'wd_repo_alias'];
    index.items = [
      summary('other-worktree', 'wd_repo', 600, '/repo-fix'),
      summary('alias-bucket', 'wd_repo_alias', 500, '/repo'),
      summary('at-root', 'wd_repo', 400, '/repo'),
      summary('subdirectory', 'wd_repo', 300, '/repo/src'),
      { ...summary('remote-from-here', 'wd_repo', 200, '/repo'), environmentId: 'ssh', environmentCwd: '/srv/repo' },
      summary('managed', 'wm_repo', 100, '/repo'),
    ];

    const page = await sessions.listForWorkdir('/repo');

    expect(workspaces.peeked).toEqual(['/repo']);
    expect(index.lastListQuery?.workspaceIds).toEqual(['wd_repo', 'wd_repo_alias']);
    expect(page).toEqual({ items: [index.items[1], index.items[2], index.items[4]] });
  });

  it('keeps the sessions of the main checkout and of a worktree apart', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { id: 'wd_repo', root: '/repo' };
    index.items = [
      summary('in-worktree', 'wd_repo', 200, '/repo-fix'),
      summary('in-main', 'wd_repo', 100, '/repo'),
    ];

    expect((await sessions.listForWorkdir('/repo')).items.map((item) => item.id)).toEqual(['in-main']);
    expect((await sessions.listForWorkdir('/repo-fix')).items.map((item) => item.id)).toEqual(['in-worktree']);
  });

  it('compares Windows-shaped working directories by drive and separator independent identity', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { id: 'wd_app', root: 'C:\\Work\\App' };
    index.items = [
      summary('other-spelling', 'wd_app', 300, 'c:/work/app/'),
      summary('same-spelling', 'wd_app', 200, 'C:\\Work\\App'),
      summary('elsewhere', 'wd_app', 100, 'C:\\Other'),
    ];

    const page = await sessions.listForWorkdir('C:\\Work\\App');

    expect(page.items.map((item) => item.id)).toEqual(['other-spelling', 'same-spelling']);
  });

  it('pages through the index until the limit fills and continues from the returned cursor', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { id: 'wd_repo', root: '/repo' };
    index.items = Array.from({ length: 250 }, (_unused, position) =>
      summary(`s${String(position)}`, 'wd_repo', 1_000 - position, position % 100 === 99 ? '/repo' : '/repo-fix'),
    );

    const first = await sessions.listForWorkdir('/repo', { limit: 1 });
    const second = await sessions.listForWorkdir('/repo', { limit: 1, before: first.nextCursor });
    const rest = await sessions.listForWorkdir('/repo', { limit: 5, before: second.nextCursor });

    expect(first).toEqual({ items: [index.items[99]], nextCursor: 's99' });
    expect(second).toEqual({ items: [index.items[199]], nextCursor: 's199' });
    expect(rest).toEqual({ items: [] });
    expect(index.listQueries.every((query) => query.limit !== undefined && query.limit > 1)).toBe(true);
  });

  it('answers a page without room with no sessions and no scan', async () => {
    const { sessions, index, workspaces } = build();
    workspaces.decision = { id: 'wd_repo', root: '/repo' };
    index.items = [summary('s0', 'wd_repo', 1_000, '/repo')];

    expect(await sessions.listForWorkdir('/repo', { limit: 0 })).toEqual({ items: [] });
    expect(index.listQueries).toEqual([]);
  });

  it('reads the deterministic project of a directory that has no project yet and passes archived through', async () => {
    const { sessions, index } = build();
    index.items = [{ ...summary('archived', 'wd_new', 100, '/new'), archived: true }];

    expect((await sessions.listForWorkdir('/new')).items).toEqual([]);
    expect((await sessions.listForWorkdir('/new', { includeArchived: true })).items.map((item) => item.id)).toEqual(['archived']);
    expect(index.lastListQuery).toMatchObject({ workspaceIds: ['wd_new'], includeArchived: true });
  });

  it.each(['os.fs.not_found', 'os.fs.not_directory'] as const)(
    'lists a directory that is gone (%s) by the working directory each implicit session recorded',
    async (code) => {
      const { sessions, index, workspaces, hostFs } = build();
      hostFs.failures.set('/repo-fix', new HostFsError(code, 'stat failed'));
      index.items = [
        summary('pinned', 'wd_repo', 800, '/repo-fix'),
        summary('main-checkout', 'wd_repo', 700, '/repo'),
        summary('old-project', 'wd_repo-fix', 600, '/repo-fix'),
        summary('managed', 'wm_fix', 400, '/repo-fix'),
        summary('project-deleted', 'wd_deleted', 300, '/repo-fix'),
        summary('unknown-cwd', 'wd_deleted', 200),
      ];

      const all = await sessions.listForWorkdir('/repo-fix');
      const first = await sessions.listForWorkdir('/repo-fix', { limit: 1 });
      const rest = await sessions.listForWorkdir('/repo-fix', { limit: 5, before: first.nextCursor });

      expect(all.items.map((item) => item.id)).toEqual(['pinned', 'old-project', 'project-deleted']);
      expect(first.items.map((item) => item.id)).toEqual(['pinned']);
      expect(rest.items.map((item) => item.id)).toEqual(['old-project', 'project-deleted']);
      expect(workspaces.peeked).toEqual([]);
    },
  );

  it('keeps to the implicit project of a directory that cannot be read', async () => {
    const { sessions, index, workspaces, hostFs } = build();
    hostFs.failures.set('/repo', new HostFsError('os.fs.permission_denied', 'stat failed'));
    workspaces.decision = { id: 'wd_repo', root: '/repo' };
    index.items = [
      summary('own', 'wd_repo', 200, '/repo'),
      summary('other-project', 'wd_other', 100, '/repo'),
    ];

    expect((await sessions.listForWorkdir('/repo')).items.map((item) => item.id)).toEqual(['own']);
    expect(workspaces.peeked).toEqual(['/repo']);
  });
});
