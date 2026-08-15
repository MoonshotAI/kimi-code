/**
 * Scenario: `/api/v2/sessions` domain-grouped session list query + batch actions.
 * Responsibilities: envelope wire shape (business outcome in `code`: 40001
 * invalid params / 40922 page_token mismatch), filters, sort orders, opaque
 * page tokens, page-number mode + total, git domain dedup/cache/degradation,
 * v2 auth error shape, the activity-status mapper, and the
 * `POST /sessions:archive` / `:restore` batch endpoints (per-item results,
 * live/cold split, cold path never materializes).
 * Wiring: real kap-server; the list tests stub `ISessionIndex` / `IGitService`
 * via DI seeds, the batch tests run real sessions in a temp home.
 * Run: `pnpm --filter @moonshot-ai/kap-server exec vitest run test/v2Sessions.test.ts`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  ISessionIndex,
  ISessionLifecycleService,
  IEventService,
  IWorkspaceLifecycleService,
  closeSessionById,
  getLiveSessionById,
  liveHandlerForSession,
  resumeSessionById,
  sessionDirOf,
  type GlobalEvent,
  type SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import {
  type FsGitStatusResponse,
  type FsPullRequest,
  IGitService,
} from '@moonshot-ai/agent-core-v2/app/git/git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  total: number;
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

  it('filters by meta.updated_before (inclusive), combined into a range', async () => {
    const before = await getData('?meta.updated_before=4000');
    expect(before.items.map((item) => item.id)).toEqual(['s2', 's3']);
    expect(before.total).toBe(2);

    const range = await getData('?meta.updated_after=3000&meta.updated_before=4000');
    expect(range.items.map((item) => item.id)).toEqual(['s2', 's3']);

    const bogus = await getError('?meta.updated_before=-1');
    expect(bogus.code).toBe(40001);
  });

  it('binds meta.updated_before into the page_token fingerprint', async () => {
    const page1 = await getData('?page_size=1&meta.updated_before=4500');
    expect(page1.items.map((item) => item.id)).toEqual(['s2']);
    expect(page1.has_more).toBe(true);

    // Same conditions + token paginates on …
    const page2 = await getData(
      `?page_size=1&meta.updated_before=4500&page_token=${page1.next_page_token}`,
    );
    expect(page2.items.map((item) => item.id)).toEqual(['s3']);

    // … but dropping the condition mid-pagination is a fingerprint flip.
    const drifted = await getError(`?page_size=1&page_token=${page1.next_page_token}`);
    expect(drifted.code).toBe(40922);
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

  it('carries total (filtered set size) in every page mode', async () => {
    const all = await getData();
    expect(all.total).toBe(3);

    const filtered = await getData(`?workspace.id=${WS_A}`);
    expect(filtered.total).toBe(2);

    // Cursor mode reports the same total on follow-up pages.
    const page1 = await getData('?page_size=2');
    expect(page1.total).toBe(3);
    const page2 = await getData(`?page_size=2&page_token=${page1.next_page_token}`);
    expect(page2.total).toBe(3);
  });

  it('paginates by 1-based page without minting tokens', async () => {
    const page1 = await getData('?page=1&page_size=2');
    expect(page1.items.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(page1.total).toBe(3);
    expect(page1.has_more).toBe(true);
    expect(page1.next_page_token).toBeNull();

    const page2 = await getData('?page=2&page_size=2');
    expect(page2.items.map((item) => item.id)).toEqual(['s3']);
    expect(page2.total).toBe(3);
    expect(page2.has_more).toBe(false);

    // A page beyond the end is an empty, terminal snapshot — total stays.
    const beyond = await getData('?page=7&page_size=2');
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(3);
    expect(beyond.has_more).toBe(false);
  });

  it('honors filters and sort in page mode', async () => {
    const page = await getData(`?workspace.id=${WS_A}&sort=meta.updated_at_asc&page=2&page_size=1`);
    expect(page.items.map((item) => item.id)).toEqual(['s1']);
    expect(page.total).toBe(2);
    expect(page.has_more).toBe(false);
  });

  it('rejects page combined with page_token (40001), and page=0', async () => {
    const first = await getData('?page_size=2');
    const both = await getError(`?page=2&page_token=${first.next_page_token}`);
    expect(both.code).toBe(40001);

    const zero = await getError('?page=0');
    expect(zero.code).toBe(40001);
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

describe('server /api/v2/sessions batch archive/restore', () => {
  interface BatchItemWire {
    id: string;
    ok: boolean;
    error?: { code: number; message: string };
  }

  interface BatchWire {
    results: BatchItemWire[];
    succeeded: number;
    failed: number;
  }

  interface BatchEnvelopeWire {
    code: number;
    msg: string;
    data: BatchWire | null;
    request_id: string;
    details?: { path: string; message: string }[];
  }

  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-sessions-batch-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

  function core(): RunningServer['core']['accessor'] {
    return (server as RunningServer).core.accessor;
  }

  /** Subscribe a bus-event collector; caller disposes the returned sub. */
  function collectEvents(): { events: GlobalEvent[]; dispose(): void } {
    const events: GlobalEvent[] = [];
    const sub = core().get(IEventService).subscribe((event) => events.push(event));
    return {
      events,
      dispose: () => {
        sub.dispose();
      },
    };
  }

  async function createSession(): Promise<{ id: string; workspace_id: string }> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const body = (await res.json()) as {
      code: number;
      data: { id: string; workspace_id: string };
    };
    expect(body.code).toBe(0);
    return body.data;
  }

  async function postBatch(path: string, body?: unknown): Promise<BatchEnvelopeWire> {
    const res = await authedFetch(server as RunningServer, base, path, {
      method: 'POST',
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(200);
    return (await res.json()) as BatchEnvelopeWire;
  }

  async function readStateJson(workspaceId: string, id: string): Promise<Record<string, unknown>> {
    const dir = sessionDirOf(home as string, `sessions/${workspaceId}`, id);
    return JSON.parse(await readFile(join(dir, 'state.json'), 'utf-8')) as Record<string, unknown>;
  }

  async function indexArchived(id: string): Promise<boolean | undefined> {
    return (await core().get(ISessionIndex).get(id))?.archived;
  }

  async function listedIds(query = ''): Promise<string[]> {
    const res = await authedFetch(server as RunningServer, base, `/api/v2/sessions${query}`);
    const body = (await res.json()) as { code: number; data: { items: { id: string }[] } };
    expect(body.code).toBe(0);
    return body.data.items.map((item) => item.id);
  }

  it('archives a cold session without materializing it or touching a workspace handler', async () => {
    const created = await createSession();
    await closeSessionById(core(), created.id);
    expect(getLiveSessionById(core(), created.id)).toBeUndefined();

    // Any materialization (resume, or the v1 single-archive route) must go
    // through handlerFor; the cold path never touches it.
    const handlerForSpy = vi.spyOn(core().get(IWorkspaceLifecycleService), 'handlerFor');
    const { events, dispose } = collectEvents();
    const before = await readStateJson(created.workspace_id, created.id);

    const body = await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      succeeded: 1,
      failed: 0,
      results: [{ id: created.id, ok: true }],
    });

    expect(handlerForSpy).not.toHaveBeenCalled();
    expect(getLiveSessionById(core(), created.id)).toBeUndefined();

    // The persisted metadata flips exactly like setArchived(true): archived
    // (+ archivedAt), updatedAt and every other field preserved.
    const after = await readStateJson(created.workspace_id, created.id);
    expect(after['archived']).toBe(true);
    expect(typeof after['archivedAt']).toBe('number');
    expect(after['updatedAt']).toBe(before['updatedAt']);
    expect(after['createdAt']).toBe(before['createdAt']);
    expect(after['agents']).toEqual(before['agents']);

    // The route drained the mirror once: the read model already answers
    // archived, and the v2 list serves the session under meta.archived=true.
    expect(await indexArchived(created.id)).toBe(true);
    expect(await listedIds('?meta.archived=true')).toEqual([created.id]);
    expect(await listedIds()).toEqual([]);

    // Same bus event the live lifecycle publishes.
    expect(events.filter((event) => event.type === 'event.session.archived')).toEqual([
      { type: 'event.session.archived', payload: { sessionId: created.id } },
    ]);
    dispose();
  });

  it('archives a live session through the full lifecycle chain', async () => {
    const created = await createSession();
    const liveHandler = liveHandlerForSession(core(), created.id);
    expect(liveHandler).toBeDefined();
    const lifecycle = liveHandler?.accessor.get(ISessionLifecycleService);
    const archiveSpy = vi.spyOn(lifecycle as ISessionLifecycleService, 'archive');
    const resumeSpy = vi.spyOn(lifecycle as ISessionLifecycleService, 'resume');
    const { events, dispose } = collectEvents();

    const body = await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    // The full chain ran: archive() (no resume needed for a live session)
    // closed and disposed the session and published the event itself.
    expect(archiveSpy).toHaveBeenCalledWith(created.id);
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(getLiveSessionById(core(), created.id)).toBeUndefined();
    expect(
      events.some(
        (event) =>
          event.type === 'event.session.archived' &&
          (event.payload as { sessionId: string }).sessionId === created.id,
      ),
    ).toBe(true);
    expect(await indexArchived(created.id)).toBe(true);
    dispose();
  });

  it('reports per-item results in input order for a live/cold/missing mixed batch', async () => {
    const live = await createSession();
    const cold = await createSession();
    await closeSessionById(core(), cold.id);

    const body = await postBatch('/api/v2/sessions:archive', {
      ids: [live.id, cold.id, 'sess_missing'],
    });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([
      { id: live.id, ok: true },
      { id: cold.id, ok: true },
      {
        id: 'sess_missing',
        ok: false,
        error: { code: 40401, message: 'session sess_missing does not exist' },
      },
    ]);
    expect(body.data?.succeeded).toBe(2);
    expect(body.data?.failed).toBe(1);
    expect(await indexArchived(live.id)).toBe(true);
    expect(await indexArchived(cold.id)).toBe(true);
  });

  it('restores a cold session without materializing it and publishes no archived event', async () => {
    const created = await createSession();
    await closeSessionById(core(), created.id);
    await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    expect(await indexArchived(created.id)).toBe(true);

    const handlerForSpy = vi.spyOn(core().get(IWorkspaceLifecycleService), 'handlerFor');
    const { events, dispose } = collectEvents();
    const before = await readStateJson(created.workspace_id, created.id);

    const body = await postBatch('/api/v2/sessions:restore', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    expect(handlerForSpy).not.toHaveBeenCalled();
    expect(getLiveSessionById(core(), created.id)).toBeUndefined();

    const after = await readStateJson(created.workspace_id, created.id);
    expect(after['archived']).toBe(false);
    expect('archivedAt' in after).toBe(false);
    expect(after['updatedAt']).toBe(before['updatedAt']);

    expect(await indexArchived(created.id)).toBe(false);
    expect(await listedIds()).toEqual([created.id]);
    // The live restore publishes nothing either — no event at all.
    expect(events.filter((event) => event.type === 'event.session.archived')).toEqual([]);
    dispose();
  });

  it('restores a live session through the lifecycle chain and keeps it live', async () => {
    const created = await createSession();
    await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    // Back to live-but-archived: resume materializes regardless of the flag.
    expect(await resumeSessionById(core(), created.id)).toBeDefined();
    const lifecycle = liveHandlerForSession(core(), created.id)?.accessor.get(
      ISessionLifecycleService,
    );
    const restoreSpy = vi.spyOn(lifecycle as ISessionLifecycleService, 'restore');

    const body = await postBatch('/api/v2/sessions:restore', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    expect(restoreSpy).toHaveBeenCalledWith(created.id);
    expect(getLiveSessionById(core(), created.id)).toBeDefined();
    expect(await indexArchived(created.id)).toBe(false);
  });

  it('validates the batch body: empty, missing, over the unique cap, duplicates', async () => {
    for (const body of [{ ids: [] }, {}]) {
      const rejected = await postBatch('/api/v2/sessions:archive', body);
      expect(rejected.code).toBe(40001);
      expect(rejected.data).toBeNull();
    }

    const tooMany = await postBatch('/api/v2/sessions:archive', {
      ids: Array.from({ length: 5001 }, (_, i) => `sess_${i}`),
    });
    expect(tooMany.code).toBe(40001);

    // Duplicates collapse before the cap; a repeated id runs once.
    const deduped = await postBatch('/api/v2/sessions:archive', {
      ids: Array.from({ length: 5001 }, () => 'sess_dup'),
    });
    expect(deduped.code).toBe(0);
    expect(deduped.data?.results).toHaveLength(1);
    expect(deduped.data?.results[0]?.ok).toBe(false);
    expect(deduped.data?.results[0]?.error?.code).toBe(40401);
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
