/**
 * Scenario: `/api/v2/sessions` domain-grouped session list query.
 * Responsibilities: envelope wire shape (business outcome in `code`: 40001
 * invalid params / 40922 page_token mismatch), filters, sort orders, opaque
 * page tokens, git domain dedup/cache/degradation, v2 auth error shape, and
 * the activity-status mapper.
 * Wiring: real kap-server; `ISessionIndex` / `IGitService` stubbed via DI seeds.
 * Run: `pnpm --filter @moonshot-ai/kap-server exec vitest run test/v2Sessions.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  ISessionIndex,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import {
  type FsGitStatusResponse,
  type FsPullRequest,
  IGitService,
} from '@moonshot-ai/agent-core-v2/app/git/git';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { mapActivityStatus } from '../src/routes/v2/sessions';
import { authHeaders, authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface SessionWireV2 {
  id: string;
  workspace: { id: string; cwd: string | null };
  meta: {
    title: string | null;
    last_prompt: string | null;
    created_at: number;
    updated_at: number;
    archived: boolean;
  };
  activity: { status: 'running' | 'approval' | 'question' | 'failed' | 'idle' };
  git?: {
    branch: string | null;
    pull_request: { number: number; state: 'open' | 'closed' | 'merged'; url: string } | null;
  };
}

interface PageWireV2 {
  items: SessionWireV2[];
  has_more: boolean;
  next_page_token: string | null;
}

/** The shared REST envelope: business outcome in `code`, payload in `data`. */
interface EnvelopeWire {
  code: number;
  msg: string;
  data: PageWireV2 | null;
  request_id: string;
  details?: { path: string; message: string }[];
}

const WS_A = 'ws_aaa';
const WS_B = 'ws_bbb';

// updatedAt desc: s1(5000) s2(4000) s3(3000) s4(2000, archived)
// createdAt desc: s1(3000) s3(2000) s2(1000) s4( 500)
const SUMMARIES: SessionSummary[] = [
  {
    id: 's1',
    workspaceId: WS_A,
    cwd: '/repo/a',
    title: 'Alpha',
    lastPrompt: 'do alpha',
    createdAt: 3_000,
    updatedAt: 5_000,
    archived: false,
  },
  {
    id: 's2',
    workspaceId: WS_A,
    cwd: '/repo/a',
    title: undefined,
    lastPrompt: 'do beta',
    createdAt: 1_000,
    updatedAt: 4_000,
    archived: false,
  },
  {
    id: 's3',
    workspaceId: WS_B,
    cwd: '/repo/b',
    title: 'Gamma',
    lastPrompt: undefined,
    createdAt: 2_000,
    updatedAt: 3_000,
    archived: false,
  },
  {
    id: 's4',
    workspaceId: WS_B,
    cwd: '/not/a/repo',
    title: 'Old',
    lastPrompt: 'archived one',
    createdAt: 500,
    updatedAt: 2_000,
    archived: true,
  },
];

/** Stub honoring the two query options the route pushes down to the index. */
function stubSessionIndex(summaries: SessionSummary[]): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: async () => ({ state: 'ready', generation: 1, degradedCount: 0 }),
    status: () => ({ state: 'ready', generation: 1, degradedCount: 0 }),
    listRecent: async (query) => {
      let items = summaries;
      if (query.workspaceIds !== undefined) {
        const ids = new Set(query.workspaceIds);
        items = items.filter((summary) => ids.has(summary.workspaceId));
      }
      if (query.includeArchived !== true) {
        items = items.filter((summary) => !summary.archived);
      }
      return { items, nextCursor: undefined };
    },
    get: async (id) => summaries.find((summary) => summary.id === id),
    count: async () => summaries.length,
    remove: async () => {},
  };
}

/** Mutable git stub: `responses` maps cwd → status; missing cwd behaves like a non-git directory. */
const gitState = {
  calls: [] as string[],
  responses: new Map<string, { branch: string; pullRequest: FsPullRequest | null }>(),
};

const gitStub: IGitService = {
  _serviceBrand: undefined,
  status: async (cwd: string): Promise<FsGitStatusResponse> => {
    gitState.calls.push(cwd);
    const preset = gitState.responses.get(cwd);
    if (preset === undefined) {
      throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `git unavailable at ${cwd}: not a repo`);
    }
    return {
      branch: preset.branch,
      ahead: 0,
      behind: 0,
      entries: {},
      additions: 0,
      deletions: 0,
      pullRequest: preset.pullRequest,
    };
  },
  diff: async () => {
    throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'not used in these tests');
  },
  findWorkTree: async () => null,
};

describe('server /api/v2/sessions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    gitState.calls = [];
    gitState.responses = new Map();
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-list-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        [ISessionIndex, stubSessionIndex(SUMMARIES)],
        [IGitService, gitStub],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as never);
      home = undefined;
    }
  });

  async function getPage(query = ''): Promise<{ status: number; body: EnvelopeWire }> {
    const res = await authedFetch(server as RunningServer, base, `/api/v2/sessions${query}`);
    return { status: res.status, body: (await res.json()) as EnvelopeWire };
  }

  /** Fetch a page expected to succeed; returns the unwrapped `data` payload. */
  async function getData(query = ''): Promise<PageWireV2> {
    const { status, body } = await getPage(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.request_id).toBe('string');
    if (body.data === null) throw new Error('expected a data payload');
    return body.data;
  }

  /** Fetch a page expected to fail with a business error code on HTTP 200. */
  async function getError(query = ''): Promise<EnvelopeWire> {
    const { status, body } = await getPage(query);
    expect(status).toBe(200);
    expect(body.data).toBeNull();
    return body;
  }

  it('lists sessions with domain-grouped shape, default sort, archived excluded', async () => {
    const page = await getData();
    expect(page.has_more).toBe(false);
    expect(page.next_page_token).toBeNull();
    expect(page.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const first = page.items[0] as SessionWireV2;
    expect(first.workspace).toEqual({ id: WS_A, cwd: '/repo/a' });
    expect(first.meta).toEqual({
      title: 'Alpha',
      last_prompt: 'do alpha',
      created_at: 3_000,
      updated_at: 5_000,
      archived: false,
      archived_at: null,
    });
    // Stubbed sessions are cold → always idle.
    expect(first.activity).toEqual({ status: 'idle' });
    // git is opt-in only.
    expect('git' in first).toBe(false);

    // title / last_prompt fall back to null when absent.
    const second = page.items[1] as SessionWireV2;
    expect(second.meta.title).toBeNull();
    const third = page.items[2] as SessionWireV2;
    expect(third.meta.last_prompt).toBeNull();
  });

  it('filters by workspace.id (single, repeated OR, unknown)', async () => {
    const single = await getData(`?workspace.id=${WS_A}`);
    expect(single.items.map((item) => item.id)).toEqual(['s1', 's2']);

    const repeated = await getData(`?workspace.id=${WS_A}&workspace.id=${WS_B}`);
    expect(repeated.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const unknown = await getData('?workspace.id=ws_nope');
    expect(unknown.items).toEqual([]);
  });

  it('filters by activity.status with OR semantics', async () => {
    const idle = await getData('?activity.status=idle');
    expect(idle.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const running = await getData('?activity.status=running&activity.status=approval');
    expect(running.items).toEqual([]);

    const bogus = await getError('?activity.status=bogus');
    expect(bogus.code).toBe(40001);
  });

  it('filters by meta.updated_after (inclusive)', async () => {
    const page = await getData('?meta.updated_after=4000');
    expect(page.items.map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('filters by meta.archived (default false / true / all)', async () => {
    const only = await getData('?meta.archived=true');
    expect(only.items.map((item) => item.id)).toEqual(['s4']);

    const all = await getData('?meta.archived=all');
    expect(all.items.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4']);

    const bogus = await getError('?meta.archived=yes');
    expect(bogus.code).toBe(40001);
  });

  it('sorts by meta.updated_at_asc and meta.created_at_desc', async () => {
    const asc = await getData('?sort=meta.updated_at_asc');
    expect(asc.items.map((item) => item.id)).toEqual(['s3', 's2', 's1']);

    const created = await getData('?sort=meta.created_at_desc');
    expect(created.items.map((item) => item.id)).toEqual(['s1', 's3', 's2']);

    const bogus = await getError('?sort=bogus');
    expect(bogus.code).toBe(40001);
  });

  it('rejects out-of-range page_size', async () => {
    for (const value of ['0', '101', 'abc']) {
      const body = await getError(`?page_size=${value}`);
      expect(body.code).toBe(40001);
    }
  });

  it('paginates with an opaque cursor across pages', async () => {
    const page1 = await getData('?page_size=2');
    expect(page1.items.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(page1.has_more).toBe(true);
    expect(typeof page1.next_page_token).toBe('string');

    const page2 = await getData(`?page_size=2&page_token=${page1.next_page_token}`);
    expect(page2.items.map((item) => item.id)).toEqual(['s3']);
    expect(page2.has_more).toBe(false);
    expect(page2.next_page_token).toBeNull();
  });

  it('paginates every sort order with the same cursor encoding', async () => {
    for (const sort of ['meta.updated_at_asc', 'meta.created_at_desc']) {
      const page1 = await getData(`?sort=${sort}&page_size=2`);
      expect(page1.has_more).toBe(true);
      const page2 = await getData(
        `?sort=${sort}&page_size=2&page_token=${page1.next_page_token}`,
      );
      expect(page2.items).toHaveLength(1);
      expect(page2.has_more).toBe(false);
      const ids = [
        ...page1.items.map((item) => item.id),
        ...page2.items.map((item) => item.id),
      ];
      expect(new Set(ids).size).toBe(3);
    }
  });

  it('rejects a page_token whose query conditions drifted (40922)', async () => {
    const page1 = await getData('?page_size=2');
    const token = page1.next_page_token;

    // page_size changed
    const drifted = await getError(`?page_size=3&page_token=${token}`);
    expect(drifted.code).toBe(40922);

    // filter added mid-pagination
    const filtered = await getError(`?page_size=2&workspace.id=${WS_A}&page_token=${token}`);
    expect(filtered.code).toBe(40922);

    // sort changed
    const resorted = await getError(
      `?page_size=2&sort=meta.updated_at_asc&page_token=${token}`,
    );
    expect(resorted.code).toBe(40922);
  });

  it('rejects a corrupted page_token (40922)', async () => {
    const body = await getError('?page_token=!!!not-a-token');
    expect(body.code).toBe(40922);
  });

  it('rejects an unknown include domain (40001)', async () => {
    const body = await getError('?include=git,metrics');
    expect(body.code).toBe(40001);
    expect(body.msg).toContain("unknown domain 'metrics'");
  });

  it('attaches the git domain per unique cwd with dedup + cache + null degradation', async () => {
    gitState.responses.set('/repo/a', {
      branch: 'main',
      pullRequest: { number: 12, state: 'draft', url: 'https://example.com/pr/12' },
    });
    gitState.responses.set('/repo/b', { branch: 'fix/x', pullRequest: null });

    const page = await getData('?include=git');

    const byId = new Map(page.items.map((item) => [item.id, item]));
    // draft folds into open (the v2 enum has no draft).
    expect(byId.get('s1')?.git).toEqual({
      branch: 'main',
      pull_request: { number: 12, state: 'open', url: 'https://example.com/pr/12' },
    });
    expect(byId.get('s2')?.git?.branch).toBe('main');
    expect(byId.get('s3')?.git).toEqual({ branch: 'fix/x', pull_request: null });

    // s1 + s2 share one cwd → one git call; /repo/b another; archived s4 excluded.
    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);

    // Second identical page hits the 60s cache — no new git calls.
    await getData('?include=git');
    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);
  });

  it('degrades non-git cwds to null fields without failing the request', async () => {
    // '/repo/a' and '/repo/b' both missing from the stub → git unavailable.
    const page = await getData('?include=git&meta.archived=all');
    for (const item of page.items) {
      expect(item.git).toEqual({ branch: null, pull_request: null });
    }
  });

  it('answers 401 with the shared envelope on v1 and v2 paths alike', async () => {
    for (const path of ['/api/v1/sessions', '/api/v2/sessions']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: number; msg: string };
      expect(body.code).toBe(40101);
    }
  });

  it('requires auth on /api/v2/sessions (bearer accepted)', async () => {
    const res = await fetch(`${base}/api/v2/sessions`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(res.status).toBe(200);
  });
});

describe('mapActivityStatus', () => {
  it('maps a cold persisted failure to failed, live outcomes still win', () => {
    const coldIdle = { busy: false, mainTurnActive: false, pendingInteraction: 'none' as const, live: false as const };
    expect(mapActivityStatus(coldIdle, 'failed')).toBe('failed');
    expect(mapActivityStatus(coldIdle, 'completed')).toBe('idle');
    expect(mapActivityStatus(coldIdle, 'cancelled')).toBe('idle');
    expect(mapActivityStatus(coldIdle)).toBe('idle');
    // A live session never reads the persisted value.
    expect(mapActivityStatus({ ...coldIdle, live: true }, 'failed')).toBe('idle');
    expect(
      mapActivityStatus({ busy: true, mainTurnActive: true, pendingInteraction: 'none', live: true }, 'failed'),
    ).toBe('running');
  });

  it('maps pending interactions ahead of an active turn', () => {
    expect(
      mapActivityStatus({ busy: true, mainTurnActive: true, pendingInteraction: 'approval' }),
    ).toBe('approval');
    expect(
      mapActivityStatus({ busy: true, mainTurnActive: true, pendingInteraction: 'question' }),
    ).toBe('question');
  });

  it('maps busy / mainTurnActive to running', () => {
    expect(
      mapActivityStatus({ busy: true, mainTurnActive: false, pendingInteraction: 'none' }),
    ).toBe('running');
    expect(
      mapActivityStatus({ busy: false, mainTurnActive: true, pendingInteraction: 'none' }),
    ).toBe('running');
  });

  it('maps a failed last turn to failed only when idle', () => {
    expect(
      mapActivityStatus({
        busy: false,
        mainTurnActive: false,
        pendingInteraction: 'none',
        lastTurnReason: 'failed',
      }),
    ).toBe('failed');
    expect(
      mapActivityStatus({
        busy: true,
        mainTurnActive: true,
        pendingInteraction: 'none',
        lastTurnReason: 'failed',
      }),
    ).toBe('running');
  });

  it('maps cold-session defaults (and completed / cancelled) to idle', () => {
    expect(mapActivityStatus({ busy: false, mainTurnActive: false, pendingInteraction: 'none' })).toBe(
      'idle',
    );
    for (const lastTurnReason of ['completed', 'cancelled'] as const) {
      expect(
        mapActivityStatus({
          busy: false,
          mainTurnActive: false,
          pendingInteraction: 'none',
          lastTurnReason,
        }),
      ).toBe('idle');
    }
  });
});
