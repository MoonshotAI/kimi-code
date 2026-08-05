/**
 * Scenario: `/api/v2/sessions` domain-grouped session list query.
 * Responsibilities: envelope-free wire shape, filters, sort orders, opaque
 * page tokens (409 on drift), git domain dedup/cache/degradation, v2 auth
 * error shape, and the activity-status mapper.
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

interface ErrorWireV2 {
  error: { code: string; message: string };
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

  async function getPage(
    query = '',
  ): Promise<{ status: number; body: PageWireV2 & ErrorWireV2 }> {
    const res = await authedFetch(server as RunningServer, base, `/api/v2/sessions${query}`);
    return { status: res.status, body: (await res.json()) as PageWireV2 & ErrorWireV2 };
  }

  it('lists sessions with domain-grouped shape, default sort, archived excluded', async () => {
    const { status, body } = await getPage();
    expect(status).toBe(200);
    expect(body.has_more).toBe(false);
    expect(body.next_page_token).toBeNull();
    expect(body.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const first = body.items[0] as SessionWireV2;
    expect(first.workspace).toEqual({ id: WS_A, cwd: '/repo/a' });
    expect(first.meta).toEqual({
      title: 'Alpha',
      last_prompt: 'do alpha',
      created_at: 3_000,
      updated_at: 5_000,
      archived: false,
    });
    // Stubbed sessions are cold → always idle.
    expect(first.activity).toEqual({ status: 'idle' });
    // git is opt-in only.
    expect('git' in first).toBe(false);

    // title / last_prompt fall back to null when absent.
    const second = body.items[1] as SessionWireV2;
    expect(second.meta.title).toBeNull();
    const third = body.items[2] as SessionWireV2;
    expect(third.meta.last_prompt).toBeNull();
  });

  it('filters by workspace.id (single, repeated OR, unknown)', async () => {
    const single = await getPage(`?workspace.id=${WS_A}`);
    expect(single.body.items.map((item) => item.id)).toEqual(['s1', 's2']);

    const repeated = await getPage(`?workspace.id=${WS_A}&workspace.id=${WS_B}`);
    expect(repeated.body.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const unknown = await getPage('?workspace.id=ws_nope');
    expect(unknown.status).toBe(200);
    expect(unknown.body.items).toEqual([]);
  });

  it('filters by activity.status with OR semantics', async () => {
    const idle = await getPage('?activity.status=idle');
    expect(idle.body.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const running = await getPage('?activity.status=running&activity.status=approval');
    expect(running.body.items).toEqual([]);

    const bogus = await getPage('?activity.status=bogus');
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('invalid_param');
  });

  it('filters by meta.updated_after (inclusive)', async () => {
    const { body } = await getPage('?meta.updated_after=4000');
    expect(body.items.map((item) => item.id)).toEqual(['s1', 's2']);
  });

  it('filters by meta.archived (default false / true / all)', async () => {
    const only = await getPage('?meta.archived=true');
    expect(only.body.items.map((item) => item.id)).toEqual(['s4']);

    const all = await getPage('?meta.archived=all');
    expect(all.body.items.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4']);

    const bogus = await getPage('?meta.archived=yes');
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('invalid_param');
  });

  it('sorts by meta.updated_at_asc and meta.created_at_desc', async () => {
    const asc = await getPage('?sort=meta.updated_at_asc');
    expect(asc.body.items.map((item) => item.id)).toEqual(['s3', 's2', 's1']);

    const created = await getPage('?sort=meta.created_at_desc');
    expect(created.body.items.map((item) => item.id)).toEqual(['s1', 's3', 's2']);

    const bogus = await getPage('?sort=bogus');
    expect(bogus.status).toBe(400);
    expect(bogus.body.error.code).toBe('invalid_param');
  });

  it('rejects out-of-range page_size', async () => {
    for (const value of ['0', '101', 'abc']) {
      const { status, body } = await getPage(`?page_size=${value}`);
      expect(status).toBe(400);
      expect(body.error.code).toBe('invalid_param');
    }
  });

  it('paginates with an opaque cursor across pages', async () => {
    const page1 = await getPage('?page_size=2');
    expect(page1.status).toBe(200);
    expect(page1.body.items.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(page1.body.has_more).toBe(true);
    expect(typeof page1.body.next_page_token).toBe('string');

    const page2 = await getPage(`?page_size=2&page_token=${page1.body.next_page_token}`);
    expect(page2.status).toBe(200);
    expect(page2.body.items.map((item) => item.id)).toEqual(['s3']);
    expect(page2.body.has_more).toBe(false);
    expect(page2.body.next_page_token).toBeNull();
  });

  it('paginates every sort order with the same cursor encoding', async () => {
    for (const sort of ['meta.updated_at_asc', 'meta.created_at_desc']) {
      const page1 = await getPage(`?sort=${sort}&page_size=2`);
      expect(page1.body.has_more).toBe(true);
      const page2 = await getPage(
        `?sort=${sort}&page_size=2&page_token=${page1.body.next_page_token}`,
      );
      expect(page2.status).toBe(200);
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.has_more).toBe(false);
      const ids = [
        ...page1.body.items.map((item) => item.id),
        ...page2.body.items.map((item) => item.id),
      ];
      expect(new Set(ids).size).toBe(3);
    }
  });

  it('rejects a page_token whose query conditions drifted (409)', async () => {
    const page1 = await getPage('?page_size=2');
    const token = page1.body.next_page_token;

    // page_size changed
    const drifted = await getPage(`?page_size=3&page_token=${token}`);
    expect(drifted.status).toBe(409);
    expect(drifted.body.error.code).toBe('page_token_mismatch');

    // filter added mid-pagination
    const filtered = await getPage(`?page_size=2&workspace.id=${WS_A}&page_token=${token}`);
    expect(filtered.status).toBe(409);

    // sort changed
    const resorted = await getPage(`?page_size=2&sort=meta.updated_at_asc&page_token=${token}`);
    expect(resorted.status).toBe(409);
  });

  it('rejects a corrupted page_token (409)', async () => {
    const { status, body } = await getPage('?page_token=!!!not-a-token');
    expect(status).toBe(409);
    expect(body.error.code).toBe('page_token_mismatch');
  });

  it('rejects an unknown include domain (400)', async () => {
    const { status, body } = await getPage('?include=git,metrics');
    expect(status).toBe(400);
    expect(body.error.code).toBe('invalid_param');
  });

  it('attaches the git domain per unique cwd with dedup + cache + null degradation', async () => {
    gitState.responses.set('/repo/a', {
      branch: 'main',
      pullRequest: { number: 12, state: 'draft', url: 'https://example.com/pr/12' },
    });
    gitState.responses.set('/repo/b', { branch: 'fix/x', pullRequest: null });

    const { status, body } = await getPage('?include=git');
    expect(status).toBe(200);

    const byId = new Map(body.items.map((item) => [item.id, item]));
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
    const again = await getPage('?include=git');
    expect(again.status).toBe(200);
    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);
  });

  it('degrades non-git cwds to null fields without failing the request', async () => {
    // '/repo/a' and '/repo/b' both missing from the stub → git unavailable.
    const { status, body } = await getPage('?include=git&meta.archived=all');
    expect(status).toBe(200);
    for (const item of body.items) {
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
