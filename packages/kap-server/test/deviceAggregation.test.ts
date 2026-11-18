import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ErrorCode } from '../src/protocol/error-codes';

import { listAllSessionsAcrossDevices, listSessionsAcrossDevices, type SessionsListOutcome } from '../src/routes/sessionsAcrossDevices';
import type { ListSessionsQuery } from '../src/protocol/rest-session';
import { DeviceManager } from '../src/services/devices/deviceManager';
import { DeviceSourceError, type DeviceSources } from '../src/services/devices/deviceFanout';
import type { DeviceHttpRequest, DeviceSession } from '../src/services/devices/deviceSession';
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
  const filter = query['workspace_id'] === undefined ? undefined : [query['workspace_id']].flat();
  const sorted = sessions
    .filter((session) => filter === undefined || filter.includes(session.workspace))
    .toSorted((a, b) => (after([a.updated, a.id], [b.updated, b.id]) ? 1 : -1));
  const pageSize = Number(query['page_size'] ?? 50);
  if (query['fields'] === undefined && (pageSize > 100 || Number(query['group_page_size'] ?? 5) > 100)) {
    throw new DeviceSourceError(ErrorCode.VALIDATION_FAILED, 'full session pages are limited to 100');
  }
  if (query['sort'] === 'updated_at_asc') sorted.reverse();
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
      workspace_id: session.workspace,
      updated_at: new Date(session.updated).toISOString(),
      created_at: new Date(0).toISOString(),
      archived: false,
    };
  if (query['view'] === 'by_workspace') {
    const groups = new Map<string, FakeSession[]>();
    for (const session of sorted) groups.set(session.workspace, [...(groups.get(session.workspace) ?? []), session]);
    const list = [...groups].map(([workspace, members]) => {
        return { workspace_id: workspace, sessions: members.slice(0, Number(query['group_page_size'] ?? 5)).map(toItem), total: members.length, updated: members[0]!.updated };
    });
    if (query['sort'] !== 'updated_at_asc') list.reverse();
    let groupStart = 0;
    if (query['page_token']) {
      const [key, id] = JSON.parse(String(query['page_token'])) as [number, string];
      groupStart = list.findIndex((group) => group.updated < key || group.updated === key && group.workspace_id > id);
      if (groupStart === -1) groupStart = list.length;
    }
    const window = list.slice(groupStart, groupStart + pageSize);
    const hasMore = groupStart + pageSize < list.length;
    return {
      groups: window.map(({ updated: _updated, ...group }) => group),
      total: list.length,
      has_more: hasMore,
      next_page_token: hasMore ? JSON.stringify([window.at(-1)!.updated, window.at(-1)!.workspace_id]) : undefined,
    };
  }
  return {
    items: window.map(toItem),
    total: sorted.length,
    has_more: hasMore,
    next_page_token: hasMore ? JSON.stringify([window.at(-1)!.updated, window.at(-1)!.id]) : undefined,
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

function fakeDevice(projects: FakeProject[], sessions: FakeSession[], requests: string[] = []): DeviceSession {
  return {
    request: async (req: DeviceHttpRequest) => {
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

function localList(sessions: FakeSession[]): (query: Omit<ListSessionsQuery, 'devices'>) => Promise<SessionsListOutcome> {
  return async (query) => {
    const wire: Query = {};
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) wire[key] = Array.isArray(value) ? value.map(String) : String(value);
    }
    return { ok: true, data: serve(sessions, wire) as never };
  };
}

function sourcesOf(devices: Array<{ id: string; session: DeviceSession | undefined }>): DeviceSources {
  return { sources: () => devices };
}

function ids(data: unknown): string[] {
  return ((data as { items: Array<{ id: string }> }).items).map((item) => item.id);
}

async function list(
  query: Partial<ListSessionsQuery>,
  devices: DeviceSources,
  local: FakeSession[],
): Promise<Record<string, unknown>> {
  const outcome = await listSessionsAcrossDevices({ devices: 'include', ...query } as ListSessionsQuery, devices, localList(local));
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.data as Record<string, unknown>;
}

async function collectIds(
  query: Partial<ListSessionsQuery>,
  devices: DeviceSources,
  local: FakeSession[],
): Promise<string[][]> {
  const pages: string[][] = [];
  let token = query.page_token;
  do {
    const page = await list({ ...query, page_token: token }, devices, local);
    if (query.fields !== undefined) expect((page['items'] as unknown[]).length).toBeLessThanOrEqual(query.page_size ?? 50);
    pages.push(ids(page));
    token = (page['next_page_token'] as string | undefined) ?? undefined;
  } while (token !== undefined);
  return pages;
}

describe('sessions across devices', () => {
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
  const session = fakeDevice(projects, remote);
  const devices = sourcesOf([{ id: 'dev', session }]);

  it('pages through every session once in global order and tags device sessions', async () => {
    const first = await list({ page_size: 3 }, devices, local);

    expect((await collectIds({ page_size: 3 }, devices, local)).flat()).toEqual(['l1', 'r1', 'l2', 'r2', 'r3', 'r4', 'l3', 'l4']);
    expect(first).toMatchObject({ total: 8, has_more: true });
    expect((first['items'] as Array<Record<string, unknown>>).map((item) => item['device_id'])).toEqual([undefined, 'dev', undefined]);
  });

  it('keeps later pages intact when a shown session moves to the top', async () => {
    const moving = local.map((session) => ({ ...session }));
    const first = await list({ page_size: 3 }, devices, moving);
    moving.find((session) => session.id === 'l2')!.updated = 99;
    expect(ids(first)).toEqual(['l1', 'r1', 'l2']);
    expect((await collectIds({ page_size: 3, page_token: first['next_page_token'] as string }, devices, moving)).flat()).toEqual(['r2', 'r3', 'r4', 'l3', 'l4']);
  });

  it('keeps a drained local source in later pages', async () => {
    expect(await collectIds({ page_size: 2 }, devices, local.slice(0, 1))).toEqual([['l1', 'r1'], ['r2', 'r3'], ['r4']]);
  });

  it('serves a numbered page of the merged order', async () => {
    const page = await list({ page: 2, page_size: 3 }, devices, local);
    expect(page).toMatchObject({ total: 8, has_more: true, next_page_token: undefined });
    expect(ids(page)).toEqual(['r2', 'r3', 'r4']);
  });

  it('lists only sessions of projects created from the app and routes a project filter to its device', async () => {
    const requests: string[] = [];
    const devices = sourcesOf([{ id: 'dev', session: fakeDevice(projects, remote, requests) }]);

    expect(ids(await list({ page_size: 50 }, devices, local))).not.toContain('cli');

    requests.length = 0;
    const filtered = await list({ page_size: 50, 'workspace_id': ['wd_local', 'wd_cli'] }, devices, local);
    expect(ids(filtered)).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(requests.filter((path) => path.startsWith('/api/v1/sessions'))).toEqual([]);
  });

  it('reports devices that are offline or failing and still answers with the rest', async () => {
    const failing = { ...devices.sources()[0]!.session!, request: async () => { throw new Error('tunnel closed'); } };
    const unavailableDevices = sourcesOf([{ id: 'off', session: undefined }, { id: 'broken', session: failing }, ...devices.sources()]);

    const page = await list({ page_size: 50 }, unavailableDevices, local);

    expect(ids(page)).toHaveLength(8);
    expect(page).toMatchObject({ unavailable_devices: ['broken', 'off'] });
  });

  it('orders project groups from every device by their latest session', async () => {
    const other: FakeSession[] = [{ id: 'o1', workspace: 'wm_other', updated: 95 }];
    const devices = sourcesOf([{ id: 'dev', session: fakeDevice(projects, remote) }, { id: 'other', session: fakeDevice([{ id: 'wm_other', kind: 'managed' }], other) }]);

    const page = await list({ view: 'by_workspace', page_size: 10 }, devices, local);
    expect((page['groups'] as Array<{ workspace_id: string; device_id?: string }>).map((group) => [group.workspace_id, group.device_id])).toEqual([
      ['wm_other', 'other'],
      ['wd_local', undefined],
      ['wm_dev', 'dev'],
    ]);
    expect((page['groups'] as Array<{ sessions: Array<{ device_id?: string }> }>)[0]!.sessions[0]!.device_id).toBe('other');
  });

  it('uses the local group tie-break order and returns complete id projection pages', async () => {
    const tied: FakeSession[] = [{ id: 's1', workspace: 'wm_a', updated: 90 }, { id: 's2', workspace: 'wm_b', updated: 90 }];
    const devices = sourcesOf([{ id: 'dev', session: fakeDevice([{ id: 'wm_a', kind: 'managed' as const }, { id: 'wm_b', kind: 'managed' as const }], tied) }]);
    const groups = await list({ view: 'by_workspace', page_size: 1 }, devices, []);
    expect((groups['groups'] as Array<{ workspace_id: string }>).map((group) => group.workspace_id)).toEqual(['wm_a']);

    expect((await collectIds({ fields: 'id,archived', page_size: 2 }, devices, local)).flat()).toEqual(['l1', 's2', 'l2', 'l3', 'l4']);
  });

  it.each([3, 150, 10000])('collects projected ids with page_size=%i through bounded source pages', async (pageSize) => {
    const local = Array.from({ length: 125 }, (_, index) => ({ id: `local-${index}`, workspace: 'wd_local', updated: index * 2 + 1 }));
    const remote = Array.from({ length: 225 }, (_, index) => ({ id: `remote-${index}`, workspace: 'wm_example', updated: index * 2 + 2 }));
    const requests: string[] = [];
    const devices = sourcesOf([{ id: 'example', session: fakeDevice([{ id: 'wm_example', kind: 'managed' }], remote, requests) }]);
    const query = { fields: 'id,archived', sort: 'updated_at_desc' as const, page_size: pageSize };
    const pages = await collectIds(query, devices, local);

    expect(pages.flat()).toEqual([...local, ...remote].toSorted((a, b) => b.updated - a.updated).map((session) => session.id));
    expect(pages).toHaveLength(Math.ceil((local.length + remote.length) / pageSize));
    const first = await list(query, devices, local);
    expect((first['items'] as unknown[])[0]).toEqual({ id: 'remote-224', archived: false, device_id: 'example' });
    const sessionQueries = requests.map((path) => new URL(path, 'http://example.test')).filter((url) => url.pathname === '/api/v1/sessions');
    expect(sessionQueries.some((url) => url.searchParams.has('page_token'))).toBe(true);
    for (const url of sessionQueries) {
      expect(url.searchParams.has('fields')).toBe(false);
      expect(Number(url.searchParams.get('page_size'))).toBeLessThanOrEqual(100);
    }
  });

  it.each([5, 150, 10000])('preserves group_page_size=%i in projected workspace groups', async (groupSize) => {
    const local = Array.from({ length: 125 }, (_, index) => ({ id: `local-${index}`, workspace: 'wd_local', updated: index * 2 + 1 }));
    const remote = Array.from({ length: 225 }, (_, index) => ({ id: `remote-${index}`, workspace: 'wm_example', updated: index * 2 + 2 }));
    const requests: string[] = [];
    const devices = sourcesOf([{ id: 'example', session: fakeDevice([{ id: 'wm_example', kind: 'managed' }], remote, requests) }]);
    const page = await list({ fields: 'id,archived', view: 'by_workspace', page_size: 10000, 'group_page_size': groupSize }, devices, local);
    const groups = page['groups'] as Array<{ workspace_id: string; sessions: Array<{ id: string; archived: boolean; device_id?: string }>; total: number }>;

    expect(groups.map((group) => [group.workspace_id, group.sessions.length, group.total])).toEqual([
      ['wm_example', Math.min(remote.length, groupSize), remote.length],
      ['wd_local', Math.min(local.length, groupSize), local.length],
    ]);
    expect(groups[0]!.sessions).toEqual(remote.toReversed().slice(0, groupSize).map((session) => ({ id: session.id, archived: false, device_id: 'example' })));
    expect(groups[1]!.sessions).toEqual(local.toReversed().slice(0, groupSize).map((session) => ({ id: session.id, archived: false })));
    if (groupSize > 100) {
      expect(requests.map((path) => new URL(path, 'http://example.test')).some((url) =>
        url.searchParams.get('view') === 'flat' && url.searchParams.get('workspace_id') === 'wm_example' && url.searchParams.get('fields') === 'id,archived',
      )).toBe(true);
    }
  });

  it('sorts all unpaginated sessions by the requested timestamp before projecting ids', async () => {
    const local = [{ id: 'l1', workspace: 'wd_local', updated: 90 }];
    const remote = [
      { id: 'r1', workspace: 'wm_dev', updated: 100 },
      { id: 'r2', workspace: 'wm_dev', updated: 80 },
    ];
    const devices = sourcesOf([{ id: 'dev', session: fakeDevice(projects, remote) }]);
    const all = async (query: Partial<ListSessionsQuery>) => {
      const outcome = await listAllSessionsAcrossDevices({ view: 'flat', sort: 'updated_at_desc', ...query }, devices, localList(local));
      if (!outcome.ok) throw new Error(outcome.message);
      return outcome.data as Record<string, unknown>;
    };
    const page = await all({ fields: 'id,archived', sort: 'updated_at_asc' });
    expect(ids(page)).toEqual(['r2', 'l1', 'r1']);
    expect(page['items']).toEqual(expect.arrayContaining([
      { id: 'r1', archived: false, device_id: 'dev' },
      { id: 'l1', archived: false },
    ]));
    expect(ids(await all({ sort: 'created_at_desc' }))).toEqual(['l1', 'r1', 'r2']);
    expect(ids(await all({}))).toEqual(['r1', 'l1', 'r2']);
  });

  it('rejects stale tokens and reports an unavailable source during a continuation', async () => {
    const first = await list({ page_size: 2 }, sourcesOf([{ id: 'dev', session }]), local);
    const token = first['next_page_token'] as string;
    for (const malformed of ['not-a-token', Buffer.from('{"v":2,"q":null}').toString('base64url')]) {
      const outcome = await listSessionsAcrossDevices({ devices: 'include', page_token: malformed } as ListSessionsQuery, devices, localList([]));
      expect(outcome).toMatchObject({ ok: false, code: ErrorCode.PAGE_TOKEN_MISMATCH });
    }
    const failing = { ...session, request: async (req: DeviceHttpRequest) => {
      if (req.path.startsWith('/api/v1/workspaces')) return session.request(req);
      throw new Error('offline');
    } };
    for (const [devices, code] of [
      [sourcesOf([{ id: 'other', session }]), ErrorCode.PAGE_TOKEN_MISMATCH],
      [sourcesOf([{ id: 'dev', session: failing }]), ErrorCode.DEVICE_UNAVAILABLE],
    ] as const) {
      const outcome = await listSessionsAcrossDevices(
        { devices: 'include', page_size: 2, page_token: token } as ListSessionsQuery,
        devices,
        localList(local),
      );
      expect(outcome).toMatchObject({ ok: false, code });
    }
  });
});

describe('projects across devices', () => {
  it('adds each device\'s app-created projects and names the devices that cannot answer', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-device-projects-'));
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
    const list = vi.spyOn(DeviceManager.prototype, 'list').mockReturnValue([
      { id: 'dev', entry: { host: 'dev' }, bridge: { session: fakeDevice([project, { ...project, id: 'wd_cli_000000000000', kind: 'implicit' } as never], []) } as never },
      { id: 'off', entry: { host: 'off' }, bridge: undefined },
    ]);
    const server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    const get = (path: string) =>
      fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { authorization: `Bearer ${server.authTokenService.getToken()}` } }).then((response) => response.json());
    try {
      expect(await get('/api/v1/workspaces')).toMatchObject({ code: 0, data: { items: [] } });
      expect(await get('/api/v1/workspaces?devices=include')).toMatchObject({
        code: 0,
        data: { items: [{ id: project.id, device_id: 'dev' }] },
      });
    } finally {
      list.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});

function sessionDevice(projects: FakeProject[], sessions: Array<Record<string, unknown>>, requests: string[]): DeviceSession {
  const reply = (status: number, body: unknown) => ({ status, headers: {}, body: Buffer.from(JSON.stringify(body)) });
  return {
    request: async (req: DeviceHttpRequest) => {
      requests.push(req.path);
      const { pathname, query } = parseQuery(req.path);
      if (pathname === '/api/v1/workspaces') return reply(200, { code: 0, msg: 'success', data: { items: projects } });
      if (pathname === '/api/v1/sessions') {
        const fake = sessions.filter((session) =>
          query['archived'] === 'true' || query['archived_only'] === 'true'
            ? session['archived'] === true
            : query['archived'] === 'all' || query['include_archive'] === 'true' || session['archived'] !== true,
        ).map((session) => ({
          id: String(session['id']),
          workspace: String(session['workspace_id']),
          updated: Date.parse(String(session['updated_at'])),
          archived: session['archived'] === true,
        }));
        return reply(200, { code: 0, msg: 'success', data: serve(fake, query) });
      }
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

describe('v1 sessions across devices', () => {
  it('lists flat and grouped sessions across devices and finds a session by id on the device that owns it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-device-sessions-'));
    const remote: Array<Record<string, unknown>> = [];
    const requests: string[] = [];
    const dev = { id: 'dev', entry: { host: 'dev' }, bridge: { session: sessionDevice([{ id: 'wm_dev', kind: 'managed' }], remote, requests) } as never };
    const list = vi.spyOn(DeviceManager.prototype, 'list').mockReturnValue([dev, { id: 'off', entry: { host: 'off' }, bridge: undefined }]);
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

      const all = await call('/api/v1/sessions?devices=include&include_archive=true');
      expect(all).toMatchObject({ code: 0, data: { has_more: false, unavailable_devices: ['off'] } });
      const items = all.data['items'] as Array<{ id: string; device_id?: string }>;
      expect(items.map((item) => [item.id, item.device_id])).toEqual([[remoteId, 'dev'], [local['id'], undefined]]);
      const sessionPaths = requests.filter((path) => path.startsWith('/api/v1/sessions'));
      expect(sessionPaths).toHaveLength(1);
      const forwarded = new URL(sessionPaths[0]!, 'http://example.test').searchParams;
      expect(forwarded.get('include_archive')).toBe('true');
      expect(forwarded.has('archived')).toBe(false);
      expect(Number(forwarded.get('page_size'))).toBeLessThanOrEqual(100);
      expect(forwarded.getAll('workspace_id')).toEqual(['wm_dev']);
      expect((await call('/api/v1/sessions?devices=include&page_size=10')).code).toBe(0);
      await call('/api/v1/sessions?devices=include&archived_only=true');
      const archived = new URL(requests.at(-1)!, 'http://example.test').searchParams;
      expect(archived.get('archived_only')).toBe('true');
      expect(archived.getAll('workspace_id')).toEqual(['wm_dev']);
      expect(Number(archived.get('page_size'))).toBeLessThanOrEqual(100);

      const projected = await call('/api/v1/sessions?devices=include&fields=id,archived');
      expect(projected).toMatchObject({ code: 0, data: { has_more: false } });
      expect(projected.data['items']).toEqual(expect.arrayContaining([
        { id: remoteId, archived: false, device_id: 'dev' },
        { id: local['id'], archived: false },
      ]));

      expect((await call(`/api/v1/sessions/${remoteId}`)).code).toBe(40401);
      expect(await call(`/api/v1/sessions/${remoteId}?devices=include`)).toMatchObject({ code: 0, data: { id: remoteId, device_id: 'dev' } });
      const own = await call(`/api/v1/sessions/${String(local['id'])}?devices=include`);
      expect(own.code).toBe(0);
      expect(own.data['device_id']).toBeUndefined();

      const grouped = await call('/api/v1/sessions?devices=include&view=by_workspace&group_page_size=5');
      expect(grouped).toMatchObject({ code: 0 });
      const groups = grouped.data['groups'] as Array<{ workspace_id: string; device_id?: string; sessions: Array<{ id: string; device_id?: string }> }>;
      expect(groups.map((group) => [group.workspace_id, group.device_id])).toEqual([
        ['wm_dev', 'dev'],
        [local['workspace_id'], undefined],
      ]);
      expect(groups[0]!.sessions).toEqual([expect.objectContaining({ id: remoteId, device_id: 'dev' })]);
      expect(await call('/api/v1/sessions?devices=include&view=by_workspace&workspace_id=wm_dev')).toMatchObject({
        code: 0,
        data: { groups: [{ workspace_id: 'wm_dev', device_id: 'dev' }] },
      });

      expect((await call('/api/v1/sessions/session_missing?devices=include')).code).toBe(50005);
      list.mockReturnValue([dev]);
      expect((await call('/api/v1/sessions/session_missing?devices=include')).code).toBe(40401);
    } finally {
      list.mockRestore();
      await server.close();
      await rm(home, { recursive: true, force: true });
    }
  });
});
