import { describe, expect, it, vi } from 'vitest';
import { toAppSessionFromV2, isPlaceholderSessionUsage } from '../src/api/daemon/mappers';
import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { isPageTokenMismatchError, V2_PAGE_TOKEN_MISMATCH_CODE } from '../src/api/errors';
import type { AgentProjector } from '../src/api/daemon/projector';
import type { V2Session } from '../src/api/types';

// toAppSessionFromV2 — v2 domain 结构（GET /api/v2/sessions）折回 AppSession。

describe('toAppSessionFromV2', () => {
  function makeV2(over: {
    id: string;
    title?: string | null;
    lastPrompt?: string | null;
    cwd?: string | null;
    status?: V2Session['activity']['status'];
    workspaceId?: string;
    git?: V2Session['git'];
    withGit?: boolean;
  }): V2Session {
    const base: V2Session = {
      id: over.id,
      workspace: { id: over.workspaceId ?? 'ws1', cwd: over.cwd === undefined ? '/w' : over.cwd },
      meta: {
        title: over.title === undefined ? `title-${over.id}` : over.title,
        last_prompt: over.lastPrompt === undefined ? null : over.lastPrompt,
        created_at: Date.parse('2026-01-01T00:00:00.000Z'),
        updated_at: Date.parse('2026-01-02T00:00:00.000Z'),
        archived: false,
        archived_at: null,
      },
      activity: { status: over.status ?? 'idle' },
    };
    if (over.withGit === true) base.git = over.git ?? { branch: null, pull_request: null };
    return base;
  }

  it('falls back title → last_prompt → id prefix', () => {
    expect(toAppSessionFromV2(makeV2({ id: 'a' })).title).toBe('title-a');
    expect(toAppSessionFromV2(makeV2({ id: 'a', title: null, lastPrompt: 'lp' })).title).toBe('lp');
    expect(
      toAppSessionFromV2(makeV2({ id: '0123456789abcdef', title: null, lastPrompt: null })).title,
    ).toBe('0123456789ab');
  });

  it('maps activity status back to busy/pendingInteraction/lastTurnReason', () => {
    const running = toAppSessionFromV2(makeV2({ id: 'a', status: 'running' }));
    expect(running.busy).toBe(true);
    // v2 running covers background/sub-agent leases too — the mapper must NOT
    // claim a main turn until the domain carries a dedicated flag.
    expect(running.mainTurnActive).toBeUndefined();
    expect(toAppSessionFromV2(makeV2({ id: 'a', status: 'approval' })).pendingInteraction).toBe(
      'approval',
    );
    expect(toAppSessionFromV2(makeV2({ id: 'a', status: 'question' })).pendingInteraction).toBe(
      'question',
    );
    expect(toAppSessionFromV2(makeV2({ id: 'a', status: 'failed' })).lastTurnReason).toBe('failed');
    const idle = toAppSessionFromV2(makeV2({ id: 'a', status: 'idle' }));
    expect(idle.busy).toBe(false);
    expect(idle.pendingInteraction).toBeUndefined();
    expect(idle.lastTurnReason).toBeUndefined();
  });

  it('maps null cwd to empty string and fills placeholder usage', () => {
    const s = toAppSessionFromV2(makeV2({ id: 'a', cwd: null }));
    expect(s.cwd).toBe('');
    expect(isPlaceholderSessionUsage(s.usage)).toBe(true);
  });

  it('maps an empty workspace id to undefined', () => {
    expect(toAppSessionFromV2(makeV2({ id: 'a', workspaceId: '' })).workspaceId).toBeUndefined();
  });

  it('maps the git domain PR through; unchecked sessions stay undefined', () => {
    const pr = { number: 42, state: 'open' as const, url: 'https://x/pr/42' };
    expect(
      toAppSessionFromV2(makeV2({ id: 'a', withGit: true, git: { branch: 'main', pull_request: pr } }))
        .pullRequest,
    ).toEqual(pr);
    expect(toAppSessionFromV2(makeV2({ id: 'a', withGit: true })).pullRequest).toBeNull();
    expect(toAppSessionFromV2(makeV2({ id: 'a' })).pullRequest).toBeUndefined();
  });
});

// listSessionsV2 — 真路径：v2 响应裹 v1 envelope（{code,msg,data}），错误码
// 40001/40922 走 envelope code（见 kap-server routes/v2/sessions.ts）。

describe('DaemonKimiWebApi.listSessionsV2', () => {
  const identity = { clientId: 'web_t', clientName: 't', clientVersion: '0', clientUiMode: 'web' };

  function makeApi(): DaemonKimiWebApi {
    return new DaemonKimiWebApi({
      origin: 'http://test.local',
      identity,
      projectorFactory: () => ({}) as AgentProjector,
    });
  }

  function envelope(data: unknown): Response {
    return new Response(JSON.stringify({ code: 0, msg: '', data, request_id: 'r' }), {
      status: 200,
    });
  }

  function v2Item(id: string): V2Session {
    return {
      id,
      workspace: { id: 'ws1', cwd: '/w' },
      meta: {
        title: `title-${id}`,
        last_prompt: null,
        created_at: 1,
        updated_at: 2,
        archived: false,
        archived_at: null,
      },
      activity: { status: 'idle' },
    };
  }

  it('calls /api/v2/sessions and unwraps the v1-enveloped page', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ items: [v2Item('a')], has_more: true, next_page_token: 'tok1' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const page = await makeApi().listSessionsV2({ pageSize: 50, include: 'git' });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/api/v2/sessions');
    expect(url.searchParams.get('page_size')).toBe('50');
    expect(url.searchParams.get('include')).toBe('git');
    expect(page.items[0]!.id).toBe('a');
    expect(page.hasMore).toBe(true);
    expect(page.nextPageToken).toBe('tok1');
  });

  it('sends the page token and archived flag through', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ items: [], has_more: false, next_page_token: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().listSessionsV2({ pageToken: 'tok1', archived: 'all' });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.get('page_token')).toBe('tok1');
    expect(url.searchParams.get('meta.archived')).toBe('all');
  });

  it('serializes filter arrays as repeated params (OR semantics)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      envelope({ items: [], has_more: false, next_page_token: null }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeApi().listSessionsV2({
      workspaceIds: ['ws1', 'ws2'],
      statuses: ['running', 'approval'],
    });

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.searchParams.getAll('workspace.id')).toEqual(['ws1', 'ws2']);
    expect(url.searchParams.getAll('activity.status')).toEqual(['running', 'approval']);
  });

  it('surfaces a 40922 envelope as a page-token mismatch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: V2_PAGE_TOKEN_MISMATCH_CODE,
          msg: 'page_token does not match the query conditions',
          request_id: 'r',
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const err = await makeApi()
      .listSessionsV2({ pageToken: 'stale' })
      .catch((e: unknown) => e);
    expect(isPageTokenMismatchError(err)).toBe(true);
  });
});
