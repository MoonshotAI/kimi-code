import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';

import { listSessionsAcrossHosts } from '../src/routes/v2/sessionsAcrossHosts';
import type { V2SessionsListOutcome, V2SessionsListQuery } from '../src/routes/v2/sessions';
import { HostBridgeManager } from '../src/services/hosts/hostBridgeManager';
import { HostSourceError, type HostSources } from '../src/services/hosts/hostFanout';
import type { HostHttpRequest, HostSession } from '../src/services/hosts/hostSession';
import { startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface FakeSession {
  readonly id: string;
  readonly workspace: string;
  updated: number;
}

interface FakeProject {
  readonly id: string;
  readonly kind: 'managed' | 'implicit';
}

type Query = Partial<Record<string, string | string[]>>;

function after(a: [number, string], b: [number, string]): boolean {
  return a[0] === b[0] ? a[1] < b[1] : a[0] < b[0];
}

function serve(sessions: readonly FakeSession[], query: Query): Record<string, unknown> {
  const filter = query['workspace.id'] === undefined ? undefined : [query['workspace.id']].flat();
  const sorted = sessions
    .filter((session) => filter === undefined || filter.includes(session.workspace))
    .toSorted((a, b) => (after([a.updated, a.id], [b.updated, b.id]) ? 1 : -1));
  const pageSize = Number(query['page_size'] ?? 50);
  if (query['fields'] === undefined && (pageSize > 100 || Number(query['group.page_size'] ?? 5) > 100)) {
    throw new HostSourceError(ErrorCode.VALIDATION_FAILED, 'full session pages are limited to 100');
  }
  if (query['sort'] === 'meta.updated_at_asc') sorted.reverse();
  let start = 0;
  if (query['page'] !== undefined) start = (Number(query['page']) - 1) * pageSize;
  else if (query['page_token']) {
    const cursor = JSON.parse(String(query['page_token'])) as [number, string];
    start = sorted.findIndex((session) => after([session.updated, session.id], cursor));
    if (start === -1) start = sorted.length;
  }
  const window = sorted.slice(start, start + pageSize);
  const hasMore = start + pageSize < sorted.length;
  const toItem = (session: FakeSession) => query['fields'] !== undefined
    ? { id: session.id, archived: false }
    : {
      id: session.id,
      workspace: { id: session.workspace, cwd: null },
      meta: { updated_at: session.updated, created_at: 0, archived: false },
    };
  if (query['view'] === 'by_workspace') {
    const groups = new Map<string, FakeSession[]>();
    for (const session of sorted) groups.set(session.workspace, [...(groups.get(session.workspace) ?? []), session]);
    const list = [...groups].map(([workspace, members]) => {
        return { workspace: { id: workspace, cwd: null }, sessions: members.slice(0, Number(query['group.page_size'] ?? 5)).map(toItem), total: members.length, updated: members[0]!.updated };
    });
    if (query['sort'] !== 'meta.updated_at_asc') list.reverse();
    let groupStart = 0;
    if (query['page_token']) {
      const [key, id] = JSON.parse(String(query['page_token'])) as [number, string];
      groupStart = list.findIndex((group) => group.updated < key || group.updated === key && group.workspace.id > id);
      if (groupStart === -1) groupStart = list.length;
    }
    const window = list.slice(groupStart, groupStart + pageSize);
    const hasMore = groupStart + pageSize < list.length;
    return {
      groups: window.map(({ updated: _updated, ...group }) => group),
      total: list.length,
      has_more: hasMore,
      next_page_token: hasMore ? JSON.stringify([window.at(-1)!.updated, window.at(-1)!.workspace.id]) : null,
    };
  }
  return {
    items: window.map(toItem),
    total: sorted.length,
    has_more: hasMore,
    next_page_token: hasMore ? JSON.stringify([window.at(-1)!.updated, window.at(-1)!.id]) : null,
  };
}

function parseQuery(path: string): { pathname: string; query: Query } {
  const url = new URL(path, 'http://host');
  const query: Query = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  return { pathname: url.pathname, query };
}

function fakeHost(projects: FakeProject[], sessions: FakeSession[], requests: string[] = []): HostSession {
  return {
    request: async (req: HostHttpRequest) => {
      requests.push(req.path);
      const { pathname, query } = parseQuery(req.path);
      const data = pathname === '/api/v1/workspaces' ? { items: projects } : serve(sessions, query);
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify({ code: 0, msg: 'success', data })) };
    },
    openWebSocket: () => {
      throw new Error('unexpected websocket');
    },
  };
}

function localList(sessions: FakeSession[]): (query: V2SessionsListQuery) => Promise<V2SessionsListOutcome> {
  return async (query) => {
    const wire: Query = {};
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) wire[key] = Array.isArray(value) ? value.map(String) : String(value);
    }
    return { ok: true, data: serve(sessions, wire) as never };
  };
}

function sourcesOf(hosts: Array<{ id: string; session: HostSession | undefined }>): HostSources {
  return { sources: () => hosts };
}

function ids(data: unknown): string[] {
  return ((data as { items: Array<{ id: string }> }).items).map((item) => item.id);
}

async function list(
  query: Partial<V2SessionsListQuery>,
  hosts: HostSources,
  local: FakeSession[],
): Promise<Record<string, unknown>> {
  const outcome = await listSessionsAcrossHosts({ hosts: 'include', ...query } as V2SessionsListQuery, hosts, localList(local));
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.data as Record<string, unknown>;
}

async function collectIds(
  query: Partial<V2SessionsListQuery>,
  hosts: HostSources,
  local: FakeSession[],
): Promise<string[][]> {
  const pages: string[][] = [];
  let token = query.page_token;
  do {
    const page = await list({ ...query, page_token: token }, hosts, local);
    if (query.fields !== undefined) expect((page['items'] as unknown[]).length).toBeLessThanOrEqual(query.page_size ?? 50);
    pages.push(ids(page));
    token = (page['next_page_token'] as string | null) ?? undefined;
  } while (token !== undefined);
  return pages;
}

describe('sessions across hosts', () => {
  const local: FakeSession[] = [
    { id: 'l1', workspace: 'wd_local', updated: 90 },
    { id: 'l2', workspace: 'wd_local', updated: 70 },
    { id: 'l3', workspace: 'wd_local', updated: 30 },
    { id: 'l4', workspace: 'wd_local', updated: 10 },
  ];
  const remote: FakeSession[] = [
    { id: 'r1', workspace: 'wm_dev', updated: 80 },
    { id: 'r2', workspace: 'wm_dev', updated: 60 },
    { id: 'r3', workspace: 'wm_dev', updated: 50 },
    { id: 'r4', workspace: 'wm_dev', updated: 40 },
    { id: 'cli', workspace: 'wd_cli', updated: 85 },
  ];
  const projects: FakeProject[] = [{ id: 'wm_dev', kind: 'managed' }, { id: 'wd_cli', kind: 'implicit' }];
  const session = fakeHost(projects, remote);
  const hosts = sourcesOf([{ id: 'dev', session }]);

  it('pages through every session once in global order and tags host sessions', async () => {
    const first = await list({ page_size: 3 }, hosts, local);

    expect((await collectIds({ page_size: 3 }, hosts, local)).flat()).toEqual(['l1', 'r1', 'l2', 'r2', 'r3', 'r4', 'l3', 'l4']);
    expect(first).toMatchObject({ total: 8, has_more: true });
    expect((first['items'] as Array<Record<string, unknown>>).map((item) => item['host_id'])).toEqual([undefined, 'dev', undefined]);
  });

  it('keeps later pages intact when a shown session moves to the top', async () => {
    const moving = local.map((session) => ({ ...session }));
    const first = await list({ page_size: 3 }, hosts, moving);
    moving.find((session) => session.id === 'l2')!.updated = 99;
    expect(ids(first)).toEqual(['l1', 'r1', 'l2']);
    expect((await collectIds({ page_size: 3, page_token: first['next_page_token'] as string }, hosts, moving)).flat()).toEqual(['r2', 'r3', 'r4', 'l3', 'l4']);
  });

  it('keeps a drained local source in later pages', async () => {
    expect(await collectIds({ page_size: 2 }, hosts, local.slice(0, 1))).toEqual([['l1', 'r1'], ['r2', 'r3'], ['r4']]);
  });

  it('serves a numbered page of the merged order', async () => {
    const page = await list({ page: 2, page_size: 3 }, hosts, local);
    expect(page).toMatchObject({ total: 8, has_more: true, next_page_token: null });
    expect(ids(page)).toEqual(['r2', 'r3', 'r4']);
  });

  it('lists only sessions of projects created from the app and routes a project filter to its host', async () => {
    const requests: string[] = [];
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote, requests) }]);

    expect(ids(await list({ page_size: 50 }, hosts, local))).not.toContain('cli');

    requests.length = 0;
    const filtered = await list({ page_size: 50, 'workspace.id': ['wd_local', 'wd_cli'] }, hosts, local);
    expect(ids(filtered)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(requests.filter((path) => path.startsWith('/api/v2/sessions'))).toEqual([]);
  });

  it('reports hosts that are offline or failing and still answers with the rest', async () => {
    const failing = { ...hosts.sources()[0]!.session!, request: async () => { throw new Error('tunnel closed'); } };
    const unavailableHosts = sourcesOf([{ id: 'off', session: undefined }, { id: 'broken', session: failing }, ...hosts.sources()]);

    const page = await list({ page_size: 50 }, unavailableHosts, local);

    expect(ids(page)).toHaveLength(8);
    expect(page).not.toHaveProperty('unavailable_hosts');
  });

  it('orders project groups from every host by their latest session', async () => {
    const other: FakeSession[] = [{ id: 'o1', workspace: 'wm_other', updated: 95 }];
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote) }, { id: 'other', session: fakeHost([{ id: 'wm_other', kind: 'managed' }], other) }]);

    const page = await list({ view: 'by_workspace', page_size: 10 }, hosts, local);
    expect((page['groups'] as Array<{ workspace: { id: string }; host_id?: string }>).map((group) => [group.workspace.id, group.host_id])).toEqual([
      ['wm_other', 'other'],
      ['wd_local', undefined],
      ['wm_dev', 'dev'],
    ]);
    expect((page['groups'] as Array<{ sessions: Array<{ host_id?: string }> }>)[0]!.sessions[0]!.host_id).toBe('other');
  });

  it('uses the local group tie-break order and returns complete id projection pages', async () => {
    const tied: FakeSession[] = [{ id: 's1', workspace: 'wm_a', updated: 90 }, { id: 's2', workspace: 'wm_b', updated: 90 }];
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost([{ id: 'wm_a', kind: 'managed' as const }, { id: 'wm_b', kind: 'managed' as const }], tied) }]);
    const groups = await list({ view: 'by_workspace', page_size: 1 }, hosts, []);
    expect((groups['groups'] as Array<{ workspace: { id: string } }>).map((group) => group.workspace.id)).toEqual(['wm_a']);

    expect((await collectIds({ fields: 'id,archived', page_size: 2 }, hosts, local)).flat()).toEqual(['l1', 's2', 'l2', 'l3', 'l4']);
  });

  it.each([3, 150, 10000])('collects projected ids with page_size=%i through bounded source pages', async (pageSize) => {
    const local = Array.from({ length: 125 }, (_, index) => ({ id: `local-${index}`, workspace: 'wd_local', updated: index * 2 + 1 }));
    const remote = Array.from({ length: 225 }, (_, index) => ({ id: `remote-${index}`, workspace: 'wm_example', updated: index * 2 + 2 }));
    const requests: string[] = [];
    const hosts = sourcesOf([{ id: 'example', session: fakeHost([{ id: 'wm_example', kind: 'managed' }], remote, requests) }]);
    const query = { fields: 'id,archived', sort: 'meta.updated_at_desc' as const, page_size: pageSize };
    const pages = await collectIds(query, hosts, local);

    expect(pages.flat()).toEqual([...local, ...remote].toSorted((a, b) => b.updated - a.updated).map((session) => session.id));
    expect(pages).toHaveLength(Math.ceil((local.length + remote.length) / pageSize));
    const first = await list(query, hosts, local);
    expect((first['items'] as unknown[])[0]).toEqual({ id: 'remote-224', archived: false, host_id: 'example' });
    const sessionQueries = requests.map((path) => new URL(path, 'http://example.test')).filter((url) => url.pathname === '/api/v2/sessions');
    expect(sessionQueries.some((url) => url.searchParams.has('page_token'))).toBe(true);
    for (const url of sessionQueries) {
      expect(url.searchParams.has('fields')).toBe(false);
      expect(Number(url.searchParams.get('page_size'))).toBeLessThanOrEqual(100);
    }
  });

  it.each([5, 150, 10000])('preserves group.page_size=%i in projected workspace groups', async (groupSize) => {
    const local = Array.from({ length: 125 }, (_, index) => ({ id: `local-${index}`, workspace: 'wd_local', updated: index * 2 + 1 }));
    const remote = Array.from({ length: 225 }, (_, index) => ({ id: `remote-${index}`, workspace: 'wm_example', updated: index * 2 + 2 }));
    const requests: string[] = [];
    const hosts = sourcesOf([{ id: 'example', session: fakeHost([{ id: 'wm_example', kind: 'managed' }], remote, requests) }]);
    const page = await list({ fields: 'id,archived', view: 'by_workspace', page_size: 10000, 'group.page_size': groupSize }, hosts, local);
    const groups = page['groups'] as Array<{ workspace: { id: string }; sessions: Array<{ id: string; archived: boolean; host_id?: string }>; total: number }>;

    expect(groups.map((group) => [group.workspace.id, group.sessions.length, group.total])).toEqual([
      ['wm_example', Math.min(remote.length, groupSize), remote.length],
      ['wd_local', Math.min(local.length, groupSize), local.length],
    ]);
    expect(groups[0]!.sessions).toEqual(remote.toReversed().slice(0, groupSize).map((session) => ({ id: session.id, archived: false, host_id: 'example' })));
    expect(groups[1]!.sessions).toEqual(local.toReversed().slice(0, groupSize).map((session) => ({ id: session.id, archived: false })));
    if (groupSize > 100) {
      expect(requests.map((path) => new URL(path, 'http://example.test')).some((url) =>
        url.searchParams.get('view') === 'flat' && url.searchParams.get('workspace.id') === 'wm_example' && url.searchParams.get('fields') === 'id,archived',
      )).toBe(true);
    }
  });

  it('rejects stale tokens and reports an unavailable source during a continuation', async () => {
    const first = await list({ page_size: 2 }, sourcesOf([{ id: 'dev', session }]), local);
    const token = first['next_page_token'] as string;
    for (const malformed of ['not-a-token', Buffer.from('{"v":2,"q":null}').toString('base64url')]) {
      const outcome = await listSessionsAcrossHosts({ hosts: 'include', page_token: malformed } as V2SessionsListQuery, hosts, localList([]));
      expect(outcome).toMatchObject({ ok: false, code: ErrorCode.PAGE_TOKEN_MISMATCH });
    }
    const failing = { ...session, request: async (req: HostHttpRequest) => {
      if (req.path.startsWith('/api/v1/workspaces')) return session.request(req);
      throw new Error('offline');
    } };
    for (const [hosts, code] of [
      [sourcesOf([{ id: 'other', session }]), ErrorCode.PAGE_TOKEN_MISMATCH],
      [sourcesOf([{ id: 'dev', session: failing }]), ErrorCode.HOST_UNAVAILABLE],
    ] as const) {
      const outcome = await listSessionsAcrossHosts(
        { hosts: 'include', page_size: 2, page_token: token } as V2SessionsListQuery,
        hosts,
        localList(local),
      );
      expect(outcome).toMatchObject({ ok: false, code });
    }
  });
});

describe('projects across hosts', () => {
  it('adds each host\'s app-created projects and names the hosts that cannot answer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-host-projects-'));
    const project = {
      id: 'wm_00000000-0000-4000-8000-000000000001',
      root: '/srv/app',
      name: 'app',
      kind: 'managed' as const,
      additional_dirs: [],
      created_at: '2026-01-01T00:00:00.000Z',
      last_opened_at: '2026-01-01T00:00:00.000Z',
      session_count: 0,
    };
    const list = vi.spyOn(HostBridgeManager.prototype, 'list').mockReturnValue([
      { id: 'dev', entry: { host: 'dev' }, bridge: { session: fakeHost([project, { ...project, id: 'wd_cli_000000000000', kind: 'implicit' } as never], []) } as never },
      { id: 'off', entry: { host: 'off' }, bridge: undefined },
    ]);
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const get = (path: string) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${server.authTokenService.getToken()}` } }).then((response) => response.json());
    try {
      expect(await get('/api/v1/workspaces')).toMatchObject({ code: 0, data: { items: [] } });
      expect(await get('/api/v1/workspaces?hosts=include')).toMatchObject({
        code: 0,
        data: { items: [{ id: project.id, host_id: 'dev' }] },
      });
    } finally {
      list.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function sessionHost(projects: FakeProject[], sessions: Array<Record<string, unknown>>, requests: string[]): HostSession {
  const reply = (status: number, body: unknown) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
  return {
    request: async (req: HostHttpRequest) => {
      requests.push(req.path);
      const { pathname } = parseQuery(req.path);
      if (pathname === '/api/v1/workspaces') return reply(200, { code: 0, msg: 'success', data: { items: projects } });
      if (pathname === '/api/v1/sessions') return reply(200, { code: 0, msg: 'success', data: { items: sessions, has_more: false } });
      const found = sessions.find((session) => pathname === `/api/v1/sessions/${String(session['id'])}`);
      return found === undefined
        ? reply(404, { code: 40401, msg: 'session does not exist' })
        : reply(200, { code: 0, msg: 'success', data: found });
    },
    openWebSocket: () => {
      throw new Error('unexpected websocket');
    },
  };
}

describe('v1 sessions across hosts', () => {
  it('lists every session at once and finds a session by id on the host that owns it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-host-sessions-'));
    const remote: Array<Record<string, unknown>> = [];
    const requests: string[] = [];
    const dev = { id: 'dev', entry: { host: 'dev' }, bridge: { session: sessionHost([{ id: 'wm_dev', kind: 'managed' }], remote, requests) } as never };
    const list = vi.spyOn(HostBridgeManager.prototype, 'list').mockReturnValue([dev, { id: 'off', entry: { host: 'off' }, bridge: undefined }]);
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const call = (path: string, body?: unknown) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${server.authTokenService.getToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then((response) => response.json() as Promise<{ code: number; data: Record<string, unknown> }>);
    try {
      const local = (await call('/api/v1/sessions', { metadata: { cwd: home } })).data;
      const remoteId = 'session_00000000-0000-4000-8000-000000000001';
      remote.push(
        { ...local, id: remoteId, workspace_id: 'wm_dev', updated_at: '2099-01-01T00:00:00.000Z' },
        { ...local, id: 'session_00000000-0000-4000-8000-000000000002', workspace_id: 'wd_cli_000000000000' },
      );

      const all = await call('/api/v1/sessions?hosts=include&include_archive=true');
      expect(all).toMatchObject({ code: 0, data: { has_more: false, unavailable_hosts: ['off'] } });
      const items = all.data['items'] as Array<{ id: string; host_id?: string }>;
      expect(items.map((item) => [item.id, item.host_id])).toEqual([[remoteId, 'dev'], [local['id'], undefined]]);
      expect(requests).toContain('/api/v1/sessions?include_archive=true');
      expect((await call('/api/v1/sessions?hosts=include&page_size=10')).code).toBe(40001);
      await call('/api/v1/sessions?hosts=include&archived_only=true');
      expect(requests).toContain('/api/v1/sessions?archived_only=true&page_size=100');

      expect((await call(`/api/v1/sessions/${remoteId}`)).code).toBe(40401);
      expect(await call(`/api/v1/sessions/${remoteId}?hosts=include`)).toMatchObject({ code: 0, data: { id: remoteId, host_id: 'dev' } });
      const own = await call(`/api/v1/sessions/${String(local['id'])}?hosts=include`);
      expect(own.code).toBe(0);
      expect(own.data['host_id']).toBeUndefined();
      expect((await call('/api/v1/sessions/session_missing?hosts=include')).code).toBe(50005);
      list.mockReturnValue([dev]);
      expect((await call('/api/v1/sessions/session_missing?hosts=include')).code).toBe(40401);
    } finally {
      list.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
