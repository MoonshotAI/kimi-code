import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  ISessionIndex,
  IEventService,
  IWorkspaceAliases,
  closeSessionById,
  getLiveSessionById,
  resumeSessionById,
  sessionDirOf,
  type Event2,
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

interface EnvelopeWire {
  code: number;
  msg: string;
  data: PageWireV2 | null;
  request_id: string;
  details?: { path: string; message: string }[];
}

const WS_A = 'ws_aaa';
const WS_B = 'ws_bbb';

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

  async function getData(query = ''): Promise<PageWireV2> {
    const { status, body } = await getPage(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.request_id).toBe('string');
    if (body.data === null) throw new Error('expected a data payload');
    return body.data;
  }

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
    expect(first.activity).toEqual({ status: 'idle' });
    expect('git' in first).toBe(false);

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

    const page2 = await getData(
      `?page_size=1&meta.updated_before=4500&page_token=${page1.next_page_token}`,
    );
    expect(page2.items.map((item) => item.id)).toEqual(['s3']);

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

  it('projects items to {id, archived} with fields=id,archived (relaxed page_size ceiling)', async () => {
    const page = await getData('?fields=id,archived&page_size=10000');
    expect(page.total).toBe(3);
    expect(page.items).toEqual([
      { id: 's1', archived: false },
      { id: 's2', archived: false },
      { id: 's3', archived: false },
    ]);

    const all = await getData('?fields=id,archived&meta.archived=all&sort=meta.updated_at_asc');
    expect(all.items).toEqual([
      { id: 's4', archived: true },
      { id: 's3', archived: false },
      { id: 's2', archived: false },
      { id: 's1', archived: false },
    ]);

    const full = await getError('?page_size=101');
    expect(full.code).toBe(40001);
    const tooBig = await getError('?fields=id,archived&page_size=10001');
    expect(tooBig.code).toBe(40001);
  });

  it('rejects malformed fields projections (40001)', async () => {
    expect((await getError('?fields=id,foo')).code).toBe(40001);
    expect((await getError('?fields=id')).code).toBe(40001);
    expect((await getError('?fields=archived')).code).toBe(40001);
    expect((await getError('?fields=id,archived&include=git')).code).toBe(40001);
  });

  it('paginates the ids projection with an opaque cursor', async () => {
    const page1 = await getData('?fields=id,archived&page_size=2');
    expect(page1.items).toEqual([
      { id: 's1', archived: false },
      { id: 's2', archived: false },
    ]);
    expect(page1.has_more).toBe(true);

    const page2 = await getData(
      `?fields=id,archived&page_size=2&page_token=${page1.next_page_token}`,
    );
    expect(page2.items).toEqual([{ id: 's3', archived: false }]);
    expect(page2.has_more).toBe(false);
  });

  it('binds the projection into the page_token fingerprint', async () => {
    const full = await getData('?page_size=2');
    expect(
      (await getError(`?fields=id,archived&page_size=2&page_token=${full.next_page_token}`)).code,
    ).toBe(40922);

    const projected = await getData('?fields=id,archived&page_size=2');
    expect((await getError(`?page_size=2&page_token=${projected.next_page_token}`)).code).toBe(
      40922,
    );
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

    const drifted = await getError(`?page_size=3&page_token=${token}`);
    expect(drifted.code).toBe(40922);

    const filtered = await getError(`?page_size=2&workspace.id=${WS_A}&page_token=${token}`);
    expect(filtered.code).toBe(40922);

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
    expect(byId.get('s1')?.git).toEqual({
      branch: 'main',
      pull_request: { number: 12, state: 'open', url: 'https://example.com/pr/12' },
    });
    expect(byId.get('s2')?.git?.branch).toBe('main');
    expect(byId.get('s3')?.git).toEqual({ branch: 'fix/x', pull_request: null });

    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);

    await getData('?include=git');
    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);
  });

  it('degrades non-git cwds to null fields without failing the request', async () => {
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

  interface GroupWireV2 {
    workspace: { id: string; cwd: string | null };
    sessions: (SessionWireV2 | { id: string; archived: boolean })[];
    total: number;
  }

  interface GroupPageWireV2 {
    groups: GroupWireV2[];
    total: number;
    has_more: boolean;
    next_page_token: string | null;
  }

  async function getGroupData(query = ''): Promise<GroupPageWireV2> {
    const { status, body } = await getPage(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    if (body.data === null) throw new Error('expected a data payload');
    return body.data as unknown as GroupPageWireV2;
  }

  it('groups the matching set per workspace with per-group totals (view=by_workspace)', async () => {
    const page = await getGroupData('?view=by_workspace');
    expect(page.total).toBe(2);
    expect(page.has_more).toBe(false);
    expect(page.next_page_token).toBeNull();

    expect(page.groups.map((group) => group.workspace.id)).toEqual([WS_A, WS_B]);
    const [a, b] = page.groups as [GroupWireV2, GroupWireV2];
    expect(a.workspace).toEqual({ id: WS_A, cwd: '/repo/a' });
    expect(a.sessions.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(a.total).toBe(2);
    expect(b.workspace).toEqual({ id: WS_B, cwd: '/repo/b' });
    expect(b.sessions.map((item) => item.id)).toEqual(['s3']);
    expect(b.total).toBe(1);

    const first = a.sessions[0] as SessionWireV2;
    expect(first.meta.last_prompt).toBe('do alpha');
    expect(first.activity).toEqual({ status: 'idle' });
    expect('git' in first).toBe(false);
  });

  it('caps each group at group.page_size while total keeps the full matching count', async () => {
    const page = await getGroupData('?view=by_workspace&group.page_size=1');
    const [a, b] = page.groups as [GroupWireV2, GroupWireV2];
    expect(a.sessions.map((item) => item.id)).toEqual(['s1']);
    expect(a.total).toBe(2);
    expect(b.sessions.map((item) => item.id)).toEqual(['s3']);
    expect(b.total).toBe(1);
  });

  it('matches the per-workspace v1 exclude_empty listing via meta.has_prompt=true', async () => {
    const flat = await getData('?meta.has_prompt=true');
    expect(flat.items.map((item) => item.id)).toEqual(['s1', 's2']);

    const inverted = await getData('?meta.has_prompt=false');
    expect(inverted.items.map((item) => item.id)).toEqual(['s3']);

    const grouped = await getGroupData('?view=by_workspace&meta.has_prompt=true');
    expect(grouped.groups.map((group) => group.workspace.id)).toEqual([WS_A]);
    expect(grouped.groups[0]?.sessions.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(grouped.groups[0]?.total).toBe(2);
  });

  it('applies sort, workspace.id, and meta.archived to groups with flat-view semantics', async () => {
    const asc = await getGroupData('?view=by_workspace&sort=meta.updated_at_asc');
    expect(asc.groups.map((group) => group.workspace.id)).toEqual([WS_B, WS_A]);
    expect(asc.groups[1]?.sessions.map((item) => item.id)).toEqual(['s2', 's1']);

    const filtered = await getGroupData(`?view=by_workspace&workspace.id=${WS_B}`);
    expect(filtered.groups.map((group) => group.workspace.id)).toEqual([WS_B]);
    expect(filtered.total).toBe(1);

    const all = await getGroupData('?view=by_workspace&meta.archived=all');
    const b = all.groups.find((group) => group.workspace.id === WS_B);
    expect(b?.sessions.map((item) => item.id)).toEqual(['s3', 's4']);
    expect(b?.total).toBe(2);
  });

  it('paginates groups with the opaque cursor and rejects condition drift (40922)', async () => {
    const page1 = await getGroupData('?view=by_workspace&page_size=1');
    expect(page1.groups.map((group) => group.workspace.id)).toEqual([WS_A]);
    expect(page1.total).toBe(2);
    expect(page1.has_more).toBe(true);

    const page2 = await getGroupData(
      `?view=by_workspace&page_size=1&page_token=${page1.next_page_token}`,
    );
    expect(page2.groups.map((group) => group.workspace.id)).toEqual([WS_B]);
    expect(page2.total).toBe(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_page_token).toBeNull();

    for (const drifted of [
      `?view=by_workspace&page_size=1&group.page_size=2&page_token=${page1.next_page_token}`,
      `?view=by_workspace&page_size=1&meta.has_prompt=true&page_token=${page1.next_page_token}`,
      `?page_size=1&page_token=${page1.next_page_token}`,
    ]) {
      expect((await getError(drifted)).code).toBe(40922);
    }
  });

  it('paginates groups by 1-based page without minting tokens', async () => {
    const page2 = await getGroupData('?view=by_workspace&page=2&page_size=1');
    expect(page2.groups.map((group) => group.workspace.id)).toEqual([WS_B]);
    expect(page2.total).toBe(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_page_token).toBeNull();

    const beyond = await getGroupData('?view=by_workspace&page=7&page_size=1');
    expect(beyond.groups).toEqual([]);
    expect(beyond.total).toBe(2);
  });

  it('supports the ids projection and include=git inside groups', async () => {
    const projected = await getGroupData('?view=by_workspace&fields=id,archived');
    expect(projected.groups[0]?.sessions).toEqual([
      { id: 's1', archived: false },
      { id: 's2', archived: false },
    ]);

    gitState.responses.set('/repo/a', { branch: 'main', pullRequest: null });
    const withGit = await getGroupData('?view=by_workspace&include=git');
    const s1 = withGit.groups[0]?.sessions.find((item) => item.id === 's1') as SessionWireV2;
    expect(s1.git).toEqual({ branch: 'main', pull_request: null });
    const s3 = withGit.groups[1]?.sessions.find((item) => item.id === 's3') as SessionWireV2;
    expect(s3.git).toEqual({ branch: null, pull_request: null });
  });

  it('rejects group.page_size without the grouped view or beyond the ceiling (40001)', async () => {
    expect((await getError('?group.page_size=5')).code).toBe(40001);
    expect((await getError('?view=by_workspace&group.page_size=0')).code).toBe(40001);
    expect((await getError('?view=by_workspace&group.page_size=101')).code).toBe(40001);
    expect((await getError('?view=by_workspace&group.page_size=abc')).code).toBe(40001);

    const projected = await getGroupData(
      '?view=by_workspace&fields=id,archived&group.page_size=10000',
    );
    expect(projected.total).toBe(2);
    expect(
      (await getError('?view=by_workspace&fields=id,archived&group.page_size=10001')).code,
    ).toBe(40001);
  });

  it('merges legacy split workspace ids into one group via alias canonicalization', async () => {
    await (server as RunningServer).close();
    const aliasSummaries: SessionSummary[] = [
      ...SUMMARIES,
      {
        id: 's5',
        workspaceId: 'ws_aaa_legacy',
        cwd: '/repo/a',
        title: 'Legacy bucket',
        lastPrompt: 'legacy one',
        createdAt: 6_000,
        updatedAt: 6_000,
        archived: false,
      },
    ];
    const aliasStub: IWorkspaceAliases = {
      _serviceBrand: undefined,
      resolveAliasIds: async (id) =>
        id === WS_A || id === 'ws_aaa_legacy' ? [WS_A, 'ws_aaa_legacy'] : [id],
    };
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        [ISessionIndex, stubSessionIndex(aliasSummaries)],
        [IGitService, gitStub],
        [IWorkspaceAliases, aliasStub],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;

    const page = await getGroupData('?view=by_workspace');
    expect(page.total).toBe(2);
    const merged = page.groups.find((group) => group.workspace.id === WS_A);
    expect(merged?.sessions.map((item) => item.id)).toEqual(['s5', 's1', 's2']);
    expect(merged?.total).toBe(3);
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

  function collectEvents(): { events: Event2[]; dispose(): void } {
    const events: Event2[] = [];
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

    const { events, dispose } = collectEvents();
    const before = await readStateJson(created.workspace_id, created.id);

    const body = await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data).toMatchObject({
      succeeded: 1,
      failed: 0,
      results: [{ id: created.id, ok: true }],
    });

    expect(getLiveSessionById(core(), created.id)).toBeUndefined();

    const after = await readStateJson(created.workspace_id, created.id);
    expect(after['archived']).toBe(true);
    expect(typeof after['archivedAt']).toBe('number');
    expect(after['updatedAt']).toBe(before['updatedAt']);
    expect(after['createdAt']).toBe(before['createdAt']);
    expect(after['agents']).toEqual(before['agents']);

    expect(await indexArchived(created.id)).toBe(true);
    expect(await listedIds('?meta.archived=true')).toEqual([created.id]);
    expect(await listedIds()).toEqual([]);

    expect(
      events
        .filter((event) => event.type === 'event.session.archived')
        .map((event) => ({
          type: event.type,
          payload: (event as { readonly payload?: unknown }).payload,
        })),
    ).toEqual([
      {
        type: 'event.session.archived',
        payload: { sessionId: created.id, workspaceId: created.workspace_id },
      },
    ]);
    dispose();
  });

  it('archives a live session through the full lifecycle chain', async () => {
    const created = await createSession();
    expect(getLiveSessionById(core(), created.id)).toBeDefined();
    const { events, dispose } = collectEvents();

    const body = await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    expect(getLiveSessionById(core(), created.id)).toBeUndefined();
    expect(
      events.some(
        (event) =>
          event.type === 'event.session.archived' &&
          ((event as { readonly payload?: unknown }).payload as { sessionId: string })
            .sessionId === created.id,
      ),
    ).toBe(true);
    expect(await indexArchived(created.id)).toBe(true);
    dispose();
  });

  it('settles an in-flight resume before classifying (no cold-write race)', async () => {
    const created = await createSession();
    await closeSessionById(core(), created.id);

    const resumePromise = resumeSessionById(core(), created.id);
    const batchPromise = postBatch('/api/v2/sessions:archive', { ids: [created.id] });

    const handle = await resumePromise;
    expect(handle).toBeDefined();
    const body = await batchPromise;
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    expect(getLiveSessionById(core(), created.id)).toBeUndefined();
    expect(await indexArchived(created.id)).toBe(true);
    expect((await readStateJson(created.workspace_id, created.id))['archived']).toBe(true);
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

    const { events, dispose } = collectEvents();
    const before = await readStateJson(created.workspace_id, created.id);

    const body = await postBatch('/api/v2/sessions:restore', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    expect(getLiveSessionById(core(), created.id)).toBeUndefined();

    const after = await readStateJson(created.workspace_id, created.id);
    expect(after['archived']).toBe(false);
    expect('archivedAt' in after).toBe(false);
    expect(after['updatedAt']).toBe(before['updatedAt']);

    expect(await indexArchived(created.id)).toBe(false);
    expect(await listedIds()).toEqual([created.id]);
    expect(events.filter((event) => event.type === 'event.session.archived')).toEqual([]);
    dispose();
  });

  it('restores a live session through the lifecycle chain and keeps it live', async () => {
    const created = await createSession();
    await postBatch('/api/v2/sessions:archive', { ids: [created.id] });
    expect(await resumeSessionById(core(), created.id)).toBeDefined();

    const body = await postBatch('/api/v2/sessions:restore', { ids: [created.id] });
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

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
