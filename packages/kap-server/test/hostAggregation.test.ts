import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionIndex } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it, vi } from 'vitest';

import { listSessionsAcrossHosts } from '../src/routes/v2/sessionsAcrossHosts';
import type { V2SessionsListOutcome, V2SessionsListQuery } from '../src/routes/v2/sessions';
import { HostBridgeManager } from '../src/services/hosts/hostBridgeManager';
import type { HostSources } from '../src/services/hosts/hostFanout';
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

function position(session: FakeSession): [number, string] {
  return [session.updated, session.id];
}

function after(a: [number, string], b: [number, string]): boolean {
  return a[0] !== b[0] ? a[0] < b[0] : a[1] < b[1];
}

function serve(sessions: readonly FakeSession[], query: Query): Record<string, unknown> {
  const filter = query['workspace.id'] === undefined ? undefined : [query['workspace.id']].flat();
  const sorted = sessions
    .filter((session) => filter === undefined || filter.includes(session.workspace))
    .toSorted((a, b) => (after(position(a), position(b)) ? 1 : -1));
  const pageSize = Number(query['page_size'] ?? 50);
  let start = 0;
  if (query['page'] !== undefined) start = (Number(query['page']) - 1) * pageSize;
  else if (query['page_token'] !== undefined) {
    const cursor = JSON.parse(String(query['page_token'])) as [number, string];
    start = sorted.findIndex((session) => after(position(session), cursor));
    if (start === -1) start = sorted.length;
  }
  const window = sorted.slice(start, start + pageSize);
  const hasMore = start + pageSize < sorted.length;
  const last = window.at(-1);
  const toItem = (session: FakeSession) =>
    query['fields'] !== undefined
      ? { id: session.id, archived: false }
      : { id: session.id, workspace: { id: session.workspace, cwd: null }, meta: { updated_at: session.updated, created_at: 0 } };
  if (query['view'] === 'by_workspace') {
    const groups = new Map<string, FakeSession[]>();
    for (const session of sorted) groups.set(session.workspace, [...(groups.get(session.workspace) ?? []), session]);
    const list = [...groups].map(([workspace, members]) => ({ workspace: { id: workspace, cwd: null }, sessions: members.slice(0, 1).map(toItem), total: members.length }));
    return { groups: list.slice(start, start + pageSize), total: list.length, has_more: start + pageSize < list.length, next_page_token: null };
  }
  return {
    items: window.map(toItem),
    total: sorted.length,
    has_more: hasMore,
    next_page_token: query['page'] === undefined && hasMore && last !== undefined ? JSON.stringify(position(last)) : null,
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
    version: '2.0.0',
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
  const projects: FakeProject[] = [
    { id: 'wm_dev', kind: 'managed' },
    { id: 'wd_cli', kind: 'implicit' },
  ];

  it('pages through every session once in global order and tags host sessions', async () => {
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote) }]);
    const pages: string[][] = [];
    let token: string | undefined;
    let first: Record<string, unknown> | undefined;
    do {
      const page = await list({ page_size: 3, page_token: token }, hosts, local);
      first ??= page;
      pages.push(ids(page));
      token = (page['next_page_token'] as string | null) ?? undefined;
    } while (token !== undefined);

    expect(pages.flat()).toEqual(['l1', 'r1', 'l2', 'r2', 'r3', 'r4', 'l3', 'l4']);
    expect(first).toMatchObject({ total: 8, has_more: true, unavailable_hosts: [] });
    expect((first['items'] as Array<Record<string, unknown>>).map((item) => item['host_id'])).toEqual([undefined, 'dev', undefined]);
  });

  it('keeps later pages intact when a shown session moves to the top', async () => {
    const moving = local.map((session) => ({ ...session }));
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote) }]);
    const first = await list({ page_size: 3 }, hosts, moving);
    moving.find((session) => session.id === 'l2')!.updated = 99;
    const rest: string[] = [];
    let token = first['next_page_token'] as string | null;
    while (token !== null) {
      const page = await list({ page_size: 3, page_token: token }, hosts, moving);
      rest.push(...ids(page));
      token = page['next_page_token'] as string | null;
    }

    expect(ids(first)).toEqual(['l1', 'r1', 'l2']);
    expect(rest).toEqual(['r2', 'r3', 'r4', 'l3', 'l4']);
  });

  it('keeps a drained local source in later pages against real servers', async () => {
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START', '0');
    vi.stubEnv('KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS', '0');
    const home = await mkdtemp(join(tmpdir(), 'kimi-host-pagination-'));
    const localServer = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: join(home, 'local'), logLevel: 'silent' });
    const remoteServer = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: join(home, 'remote'), logLevel: 'silent' });
    const create = async (server: typeof localServer): Promise<void> => {
      const headers = { authorization: `Bearer ${server.authTokenService.getToken()}` };
      const workspace = (await server.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { root: home } })).json().data;
      for (let i = 0; i < 4; i++) {
        const response = await server.app.inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { workspace_id: workspace.id } });
        expect(response.statusCode).toBe(200);
      }
      await vi.waitFor(async () => {
        expect((await server.core.accessor.get(ISessionIndex).listRecent({})).items).toHaveLength(4);
      });
    };
    await create(localServer);
    await create(remoteServer);
    const remoteSession: HostSession = {
      version: 'test',
      request: async (req) => {
        const response = await remoteServer.app.inject({
          method: req.method as 'GET',
          url: req.path,
          headers: { ...req.headers, authorization: `Bearer ${remoteServer.authTokenService.getToken()}` },
          payload: req.body?.toString('utf8'),
        });
        return { status: response.statusCode, headers: response.headers, body: Buffer.from(response.body) };
      },
      openWebSocket: () => { throw new Error('unexpected websocket'); },
    };
    const list = vi.spyOn(HostBridgeManager.prototype, 'list').mockReturnValue([{ id: 'dev', entry: { host: 'dev' }, bridge: { session: remoteSession } } as never]);
    const ids: string[] = [];
    let token: string | undefined;
    try {
      do {
        const response = await localServer.app.inject({
          method: 'GET',
          url: `/api/v2/sessions?hosts=include&page_size=3${token === undefined ? '' : `&page_token=${encodeURIComponent(token)}`}`,
          headers: { authorization: `Bearer ${localServer.authTokenService.getToken()}` },
        });
        const body = response.json();
        expect(body.code).toBe(0);
        ids.push(...body.data.items.map((item: { id: string }) => item.id));
        token = body.data.next_page_token ?? undefined;
      } while (token !== undefined);
      expect(ids).toHaveLength(8);
      expect(new Set(ids).size).toBe(8);
    } finally {
      list.mockRestore();
      await localServer.close();
      await remoteServer.close();
      await rm(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it('serves a numbered page of the merged order', async () => {
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote) }]);

    const page = await list({ page: 2, page_size: 3 }, hosts, local);

    expect(ids(page)).toEqual(['r2', 'r3', 'r4']);
    expect(page).toMatchObject({ total: 8, has_more: true, next_page_token: null });
  });

  it('lists only sessions of projects created from the app and routes a project filter to its host', async () => {
    const requests: string[] = [];
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote, requests) }]);

    const all = await list({ page_size: 50 }, hosts, local);
    expect(ids(all)).not.toContain('cli');

    requests.length = 0;
    const filtered = await list({ page_size: 50, 'workspace.id': ['wd_local', 'wd_cli'] }, hosts, local);
    expect(ids(filtered)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(requests.filter((path) => path.startsWith('/api/v2/sessions'))).toEqual([]);
  });

  it('reports hosts that are offline or failing and still answers with the rest', async () => {
    const failing: HostSession = {
      version: '2.0.0',
      request: async () => {
        throw new Error('tunnel closed');
      },
      openWebSocket: () => {
        throw new Error('unexpected websocket');
      },
    };
    const hosts = sourcesOf([
      { id: 'off', session: undefined },
      { id: 'broken', session: failing },
      { id: 'dev', session: fakeHost(projects, remote) },
    ]);

    const page = await list({ page_size: 50 }, hosts, local);

    expect(ids(page)).toHaveLength(8);
    expect(page['unavailable_hosts']).toEqual(['off', 'broken']);
  });

  it('collects every id for select-all across hosts', async () => {
    const hosts = sourcesOf([{ id: 'dev', session: fakeHost(projects, remote) }]);
    const collected: string[] = [];
    let token: string | undefined;
    do {
      const page = await list({ fields: 'id,archived', page_size: 3, page_token: token }, hosts, local);
      collected.push(...ids(page));
      token = (page['next_page_token'] as string | null) ?? undefined;
    } while (token !== undefined);

    expect(collected.toSorted()).toEqual(['l1', 'l2', 'l3', 'l4', 'r1', 'r2', 'r3', 'r4']);
  });

  it('orders project groups from every host by their latest session', async () => {
    const other: FakeSession[] = [{ id: 'o1', workspace: 'wm_other', updated: 95 }];
    const hosts = sourcesOf([
      { id: 'dev', session: fakeHost(projects, remote) },
      { id: 'other', session: fakeHost([{ id: 'wm_other', kind: 'managed' }], other) },
    ]);

    const page = await list({ view: 'by_workspace', page_size: 10 }, hosts, local);
    const groups = page['groups'] as Array<{ workspace: { id: string }; host_id?: string; sessions: Array<{ host_id?: string }> }>;

    expect(groups.map((group) => [group.workspace.id, group.host_id])).toEqual([
      ['wm_other', 'other'],
      ['wd_local', undefined],
      ['wm_dev', 'dev'],
    ]);
    expect(groups[0]!.sessions[0]!.host_id).toBe('other');
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
        data: { items: [{ id: project.id, host_id: 'dev' }], unavailable_hosts: ['off'] },
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
    version: '2.0.0',
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
      expect(requests).toContain('/api/v1/sessions?archived_only=true');

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
