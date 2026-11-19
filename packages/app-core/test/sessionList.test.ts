import { describe, expect, it, vi } from 'vitest';
import { toAppSession, isPlaceholderSessionUsage } from '../src/api/daemon/mappers';
import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { isPageTokenMismatchError, PAGE_TOKEN_MISMATCH_CODE } from '../src/api/errors';
import type { WireSession } from '../src/api/daemon/wire';

function wireItem(
  id: string,
  over: Partial<WireSession> = {},
): WireSession {
  return {
    id,
    workspace_id: 'ws1',
    cwd: '/w',
    title: `title-${id}`,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    activity: 'idle',
    archived: false,
    ...over,
  };
}

describe('toAppSession', () => {
  it('maps wire fields and detects placeholder usage', () => {
    const s = toAppSession(
      wireItem('a', {
        activity: 'turn',
        pending_interaction: 'approval',
        last_turn_outcome: 'failed',
        last_prompt: 'lp',
      }),
    );
    expect(s.id).toBe('a');
    expect(s.title).toBe('title-a');
    expect(s.busy).toBe(true);
    expect(s.mainTurnActive).toBe(true);
    expect(s.pendingInteraction).toBe('approval');
    expect(s.lastTurnReason).toBe('failed');
    expect(s.lastPrompt).toBe('lp');
    expect(s.workspaceId).toBe('ws1');
    expect(isPlaceholderSessionUsage(s.usage)).toBe(true);
  });

  it('maps an empty workspace id to undefined', () => {
    expect(toAppSession(wireItem('a', { workspace_id: '' })).workspaceId).toBeUndefined();
  });

  it('maps optional git domain PR through and keeps omitted git as undefined', () => {
    const pr = { number: 42, state: 'open' as const, url: 'https://example.test/pr/42' };
    expect(
      toAppSession(wireItem('a', { git: { branch: 'main', pull_request: pr } })).pullRequest,
    ).toEqual(pr);
    expect(toAppSession(wireItem('a', { git: {} })).pullRequest).toBeNull();
    expect(toAppSession(wireItem('a')).pullRequest).toBeUndefined();
  });
});

describe('DaemonKimiWebApi.listSessions', () => {
  const identity = { clientId: 'web_t', clientName: 't', clientVersion: '0', clientUiMode: 'web' };

  function makeApi(): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://test.local',
      identity,
    });
  }

  function envelope(data: unknown): Response {
    return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'r' }), {
      status: 200,
    });
  }

  it('calls /api/v1/sessions and maps wire items to AppSession', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({
        items: [wireItem('a', { git: { branch: 'main' } })],
        has_more: true,
        next_page_token: 'tok1',
        total: 1,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await makeApi().listSessions({ pageSize: 50, include: 'git' });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/sessions');
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(url.searchParams.get('include')).toBe('git');
    expect(page.items[0]!.id).toBe('a');
    expect(page.items[0]!.pullRequest).toBeNull();
    expect(page.hasMore).toBe(true);
    expect(page.nextPageToken).toBe('tok1');
    expect(page.total).toBe(1);
  });

  it('sends the page token, archived, and has_prompt flags through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ items: [], has_more: false, total: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await makeApi().listSessions({
      pageToken: 'tok1',
      archived: 'all',
      hasPrompt: true,
    });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('page_token')).toBe('tok1');
    expect(url.searchParams.get('archived')).toBe('all');
    expect(url.searchParams.get('has_prompt')).toBe('true');
    expect(page.nextPageToken).toBeNull();
  });

  it('serializes filter arrays as repeated params (OR semantics)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ items: [], has_more: false, total: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().listSessions({
      workspaceIds: ['ws1', 'ws2'],
      activities: ['turn', 'background'],
    });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.getAll('workspace_id')).toEqual(['ws1', 'ws2']);
    expect(url.searchParams.getAll('activity')).toEqual(['turn', 'background']);
  });

  it('surfaces a 40922 envelope as a page-token mismatch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: PAGE_TOKEN_MISMATCH_CODE,
          msg: 'page_token does not match the query conditions',
          request_id: 'r',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await makeApi()
      .listSessions({ pageToken: 'stale' })
      .catch((e: unknown) => e);
    expect(isPageTokenMismatchError(err)).toBe(true);
  });

  it('sends the page-number mode and updated_before ISO string through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ items: [], has_more: false, total: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().listSessions({ page: 3, updatedBefore: '2026-07-03T00:00:00.000Z' });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('page')).toBe('3');
    expect(url.searchParams.get('updated_before')).toBe('2026-07-03T00:00:00.000Z');
  });

  it('projects id,archived via fields=id,archived on listSessionIds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({
        items: [{ id: 'a', archived: false }],
        has_more: false,
        total: 1,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await makeApi().listSessionIds({ archived: 'all', pageSize: 10000 });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/sessions');
    expect(url.searchParams.get('fields')).toBe('id,archived');
    expect(url.searchParams.get('archived')).toBe('all');
    expect(url.searchParams.get('page_size')).toBe('10000');
    expect(page.items).toEqual([{ id: 'a', archived: false }]);
    expect(page.nextPageToken).toBeNull();
  });
});

describe('DaemonKimiWebApi.listSessionGroups', () => {
  const identity = { clientId: 'web_t', clientName: 't', clientVersion: '0', clientUiMode: 'web' };

  function makeApi(): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://test.local',
      identity,
    });
  }

  function envelope(data: unknown): Response {
    return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'r' }), {
      status: 200,
    });
  }

  it('sends the grouped-view params to /api/v1/sessions and unwraps the groups page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({
        groups: [
          { workspace_id: 'ws1', sessions: [wireItem('a')], total: 7 },
          { workspace_id: 'ws2', sessions: [wireItem('b', { workspace_id: 'ws2', metadata: { cwd: '/x' } })], total: 1 },
        ],
        has_more: true,
        next_page_token: 'gtok1',
        total: 2,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await makeApi().listSessionGroups({ groupPageSize: 5, hasPrompt: true });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/sessions');
    expect(url.searchParams.get('view')).toBe('by_workspace');
    expect(url.searchParams.get('group_page_size')).toBe('5');
    expect(url.searchParams.get('has_prompt')).toBe('true');
    expect(page.groups).toHaveLength(2);
    expect(page.groups[0]).toEqual({
      workspaceId: 'ws1',
      sessions: [expect.objectContaining({ id: 'a', cwd: '/w' })],
      total: 7,
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextPageToken).toBe('gtok1');
    expect(page.total).toBe(2);
  });

  it('serializes filter arrays and the paging token through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ groups: [], has_more: false, total: 0 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().listSessionGroups({
      workspaceIds: ['ws1', 'ws2'],
      activities: ['turn'],
      archived: 'all',
      pageToken: 'gtok1',
    });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.getAll('workspace_id')).toEqual(['ws1', 'ws2']);
    expect(url.searchParams.getAll('activity')).toEqual(['turn']);
    expect(url.searchParams.get('archived')).toBe('all');
    expect(url.searchParams.get('page_token')).toBe('gtok1');
  });
});

describe('DaemonKimiWebApi batch archive/restore', () => {
  const identity = { clientId: 'web_t', clientName: 't', clientVersion: '0', clientUiMode: 'web' };

  function makeApi(): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://test.local',
      identity,
    });
  }

  function envelope(data: unknown): Response {
    return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'r' }), {
      status: 200,
    });
  }

  const batchData = {
    results: [
      { id: 'a', ok: true },
      { id: 'b', ok: false, error: { code: 40401, message: 'session b does not exist' } },
    ],
    succeeded: 1,
    failed: 1,
  };

  it('POSTs {ids} to /api/v1/sessions:archive and returns per-item results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(batchData));
    vi.stubGlobal('fetch', fetchMock);

    const res = await makeApi().archiveSessions(['a', 'b']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/sessions:archive');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ ids: ['a', 'b'] });
    expect(res.succeeded).toBe(1);
    expect(res.results[1]).toEqual({
      id: 'b',
      ok: false,
      error: { code: 40401, message: 'session b does not exist' },
    });
  });

  it('POSTs {ids} to /api/v1/sessions:restore', async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope(batchData));
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().restoreSessions(['a', 'b']);

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v1/sessions:restore');
  });
});

describe('DaemonKimiWebApi reload session', () => {
  const identity = { clientId: 'web_t', clientName: 't', clientVersion: '0', clientUiMode: 'web' };

  function makeApi(): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://test.local',
      identity,
    });
  }

  it('POSTs an empty body to /api/v1/sessions/{id}:reload and maps the session', async () => {
    const wire = wireItem('sess/1', {
      title: 'Test',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      cwd: '/project',
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 0, msg: '', data: wire, request_id: 'r' }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const session = await makeApi().reloadSession('sess/1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/api/v1/sessions/sess%2F1:reload');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({});
    expect(session.id).toBe('sess/1');
  });
});
