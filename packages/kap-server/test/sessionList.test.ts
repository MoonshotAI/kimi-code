import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Error2,
  ErrorCodes,
  IEnvironmentService,
  ISessionIndex,
  IEventService,
  IWorkspaceAliases,
  IWorkspaceService,
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
import { FakeEnvironment } from '@moonshot-ai/agent-core-v2/environment/fakeEnvironment';
import { HostFileSystem } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostFsService';
import { HostProcessService } from '@moonshot-ai/agent-core-v2/os/backends/node-local/hostProcessService';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '../src/protocol/session';
import { mapSessionActivity } from '../src/routes/sessionList';
import { type RunningServer, startServer } from '../src/start';
import { authHeaders, authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface PageWire {
  items: (Session | { id: string; archived: boolean })[];
  total: number;
  has_more: boolean;
  next_page_token?: string;
}

interface GroupWire {
  workspace_id: string;
  sessions: (Session | { id: string; archived: boolean })[];
  total: number;
}

interface GroupPageWire {
  groups: GroupWire[];
  total: number;
  has_more: boolean;
  next_page_token?: string;
}

interface EnvelopeWire<T = PageWire> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: { path: string; message: string }[];
}

const WS_A = 'wd_aaa_000000000000';
const WS_B = 'wd_bbb_000000000000';
const WS_MISSING = 'wm_00000000-0000-0000-0000-000000000000';

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
    archivedAt: 2_500,
  },
  {
    id: 's-orphan',
    workspaceId: WS_MISSING,
    cwd: '/repo/missing',
    title: 'Orphan',
    lastPrompt: 'orphaned one',
    createdAt: 4_000,
    updatedAt: 6_000,
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

const workspaceStub: IWorkspaceService = {
  _serviceBrand: undefined,
  list: async () => [
    {
      id: WS_A,
      root: '/repo/a',
      name: 'a',
      kind: 'managed',
      additionalDirs: [],
      createdAt: 1,
      lastOpenedAt: 1,
    },
    {
      id: WS_B,
      root: '/repo/b',
      name: 'b',
      kind: 'managed',
      additionalDirs: [],
      createdAt: 1,
      lastOpenedAt: 1,
    },
  ],
  get: async (id) => (await workspaceStub.list()).find((workspace) => workspace.id === id),
  create: async () => {
    throw new Error('not used in these tests');
  },
  createOrTouch: async () => {
    throw new Error('not used in these tests');
  },
  touch: async () => {
    throw new Error('not used in these tests');
  },
  update: async () => {
    throw new Error('not used in these tests');
  },
  setPrimary: async () => {
    throw new Error('not used in these tests');
  },
  readProjectConfigDirs: async () => [],
  delete: async () => {},
};

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
  pullRequest: async (cwd: string) => gitState.responses.get(cwd)?.pullRequest ?? null,
  diff: async () => {
    throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, 'not used in these tests');
  },
  findWorkTree: async () => null,
};

function hostProcessWithoutGh(): HostProcessService {
  const service = new HostProcessService();
  const spawn = service.spawn.bind(service);
  service.spawn = async (command, args, options) => {
    if (command === 'gh') throw new Error('gh is not used in these tests');
    return spawn(command, args, options);
  };
  return service;
}

describe('server /api/v1/sessions list', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v1-sessions-list-'));
    await bootSeeded();
  });

  beforeEach(() => {
    gitState.calls = [];
    gitState.responses = new Map();
  });

  async function bootSeeded(summaries: SessionSummary[] = SUMMARIES): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        [ISessionIndex, stubSessionIndex(summaries)],
        [IWorkspaceService, workspaceStub],
        [IGitService, gitStub],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  afterAll(async () => {
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

  async function getPage<T = PageWire>(query = ''): Promise<{ status: number; body: EnvelopeWire<T> }> {
    const res = await authedFetch(server as RunningServer, base, `/api/v1/sessions${query}`);
    return { status: res.status, body: (await res.json()) as EnvelopeWire<T> };
  }

  async function getData(query = ''): Promise<PageWire> {
    const { status, body } = await getPage(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    expect(typeof body.request_id).toBe('string');
    if (body.data === null) throw new Error('expected a data payload');
    return body.data;
  }

  async function getGroupData(query = ''): Promise<GroupPageWire> {
    const { status, body } = await getPage<GroupPageWire>(query);
    expect(status).toBe(200);
    expect(body.code).toBe(0);
    if (body.data === null) throw new Error('expected a data payload');
    return body.data;
  }

  async function getError(query = ''): Promise<EnvelopeWire> {
    const { status, body } = await getPage(query);
    expect(status).toBe(200);
    expect(body.data).toBeNull();
    return body;
  }

  it('drops the legacy /api/v2/sessions routes', async () => {
    const list = await authedFetch(server as RunningServer, base, '/api/v2/sessions');
    expect(list.status).toBe(404);
    const batch = await authedFetch(server as RunningServer, base, '/api/v2/sessions:archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: ['s1'] }),
    });
    expect(batch.status).toBe(404);
  });

  it('lists sessions with the unified Session shape, default sort, archived excluded', async () => {
    const page = await getData();
    expect(page.has_more).toBe(false);
    expect(page.next_page_token).toBeUndefined();
    expect(page.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const first = page.items[0] as Session;
    expect(first).toMatchObject({
      id: 's1',
      workspace_id: WS_A,
      title: 'Alpha',
      last_prompt: 'do alpha',
      created_at: new Date(3_000).toISOString(),
      updated_at: new Date(5_000).toISOString(),
      archived: false,
      busy: false,
      main_turn_active: false,
      pending_interaction: 'none',
      metadata: { cwd: '/repo/a' },
      agent_config: { model: '' },
    });
    expect('git' in first).toBe(false);

    const second = page.items[1] as Session;
    expect(second.title).toBe('');
    const third = page.items[2] as Session;
    expect(third.last_prompt).toBeUndefined();
  });

  it('exposes the live session model on listed sessions', async () => {
    await (server as RunningServer).close();
    await writeFile(
      join(home as string, 'config.toml'),
      [
        'default_model = "stub"',
        '',
        '[providers.stub]',
        'type = "openai"',
        'base_url = "http://127.0.0.1:9999"',
        'api_key = "stub"',
        '',
        '[models.stub]',
        'provider = "stub"',
        'model = "stub"',
        'max_context_size = 1000',
        '',
      ].join('\n'),
      'utf-8',
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;

    const created = await authedFetch(server, base, '/api/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metadata: { cwd: home } }),
    });
    const createdBody = (await created.json()) as { code: number; data: { id: string } };
    expect(createdBody.code).toBe(0);
    const id = createdBody.data.id;

    const bound = await authedFetch(server, base, `/api/v1/sessions/${id}/profile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent_config: { model: 'stub' } }),
    });
    expect(((await bound.json()) as { code: number }).code).toBe(0);

    const page = await getData();
    const item = page.items.find((entry) => entry.id === id) as Session | undefined;
    expect(item?.agent_config).toEqual({ model: 'stub' });

    await rm(join(home as string, 'config.toml'), { force: true });
    await (server as RunningServer).close();
    await bootSeeded();
  });

  it('filters by workspace_id (single, repeated OR, unknown)', async () => {
    const single = await getData(`?workspace_id=${WS_A}`);
    expect(single.items.map((item) => item.id)).toEqual(['s1', 's2']);

    const repeated = await getData(`?workspace_id=${WS_A}&workspace_id=${WS_B}`);
    expect(repeated.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const unknown = await getData('?workspace_id=ws_nope');
    expect(unknown.items).toEqual([]);
    expect(unknown.total).toBe(0);
  });

  it('filters by activity with OR semantics', async () => {
    const idle = await getData('?activity=idle');
    expect(idle.items.map((item) => item.id)).toEqual(['s1', 's2', 's3']);

    const running = await getData('?activity=turn&activity=background');
    expect(running.items).toEqual([]);

    const bogus = await getError('?activity=bogus');
    expect(bogus.code).toBe(40001);
  });

  it('filters by ISO 8601 updated_after and updated_before (inclusive)', async () => {
    const t3000 = encodeURIComponent(new Date(3_000).toISOString());
    const t4000 = encodeURIComponent(new Date(4_000).toISOString());
    const after = await getData(`?updated_after=${t4000}`);
    expect(after.items.map((item) => item.id)).toEqual(['s1', 's2']);

    const before = await getData(`?updated_before=${t4000}`);
    expect(before.items.map((item) => item.id)).toEqual(['s2', 's3']);
    expect(before.total).toBe(2);

    const range = await getData(`?updated_after=${t3000}&updated_before=${t4000}`);
    expect(range.items.map((item) => item.id)).toEqual(['s2', 's3']);

    const bogus = await getError('?updated_before=not-a-date');
    expect(bogus.code).toBe(40001);
  });

  it('binds updated_before into the page_token fingerprint', async () => {
    const t4500 = encodeURIComponent(new Date(4_500).toISOString());
    const page1 = await getData(`?page_size=1&updated_before=${t4500}`);
    expect(page1.items.map((item) => item.id)).toEqual(['s2']);
    expect(page1.has_more).toBe(true);

    const page2 = await getData(
      `?page_size=1&updated_before=${t4500}&page_token=${page1.next_page_token}`,
    );
    expect(page2.items.map((item) => item.id)).toEqual(['s3']);

    const drifted = await getError(`?page_size=1&page_token=${page1.next_page_token}`);
    expect(drifted.code).toBe(40922);
  });

  it('filters by archived (default false / true / all)', async () => {
    const only = await getData('?archived=true');
    expect(only.items.map((item) => item.id)).toEqual(['s4']);

    const all = await getData('?archived=all');
    expect(all.items.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4']);

    const bogus = await getError('?archived=yes');
    expect(bogus.code).toBe(40001);
  });

  it('hides sessions of missing workspaces from flat, grouped, and id projections', async () => {
    const flat = await getData('?archived=all');
    expect(flat.items.map((item) => item.id)).toEqual(['s1', 's2', 's3', 's4']);
    expect(flat.total).toBe(4);

    const grouped = await getGroupData('?view=by_workspace&archived=all');
    expect(grouped.total).toBe(2);
    expect(grouped.groups.some((group) => group.workspace_id === WS_MISSING)).toBe(false);
    expect(grouped.groups.find((group) => group.workspace_id === WS_B)?.total).toBe(2);

    const projected = await getData('?fields=id,archived&archived=all');
    expect(projected.items.some((item) => item.id === 's-orphan')).toBe(false);
    expect(projected.total).toBe(4);
  });

  it('sorts by updated_at_asc and created_at_desc', async () => {
    const asc = await getData('?sort=updated_at_asc');
    expect(asc.items.map((item) => item.id)).toEqual(['s3', 's2', 's1']);

    const created = await getData('?sort=created_at_desc');
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

    const all = await getData('?fields=id,archived&archived=all&sort=updated_at_asc');
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
    expect(page2.next_page_token).toBeUndefined();
  });

  it('paginates every sort order with the same cursor encoding', async () => {
    for (const sort of ['updated_at_asc', 'created_at_desc']) {
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

    const filtered = await getError(`?page_size=2&workspace_id=${WS_A}&page_token=${token}`);
    expect(filtered.code).toBe(40922);

    const resorted = await getError(
      `?page_size=2&sort=updated_at_asc&page_token=${token}`,
    );
    expect(resorted.code).toBe(40922);
  });

  it('carries total (filtered set size) in every page mode', async () => {
    const all = await getData();
    expect(all.total).toBe(3);

    const filtered = await getData(`?workspace_id=${WS_A}`);
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
    expect(page1.next_page_token).toBeUndefined();

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
    const page = await getData(`?workspace_id=${WS_A}&sort=updated_at_asc&page=2&page_size=1`);
    expect(page.items.map((item) => item.id)).toEqual(['s1']);
    expect(page.total).toBe(2);
    expect(page.has_more).toBe(false);
  });

  it('rejects mutually exclusive pagination params (40001), page=0, and before_id with by_workspace', async () => {
    const first = await getData('?page_size=2');
    expect((await getError(`?page=2&page_token=${first.next_page_token}`)).code).toBe(40001);
    expect((await getError('?page=1&before_id=s1')).code).toBe(40001);
    expect((await getError('?before_id=s1&after_id=s3')).code).toBe(40001);
    expect((await getError('?view=by_workspace&before_id=s1')).code).toBe(40001);
    expect((await getError('?page=0')).code).toBe(40001);
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

  it('attaches the git domain per unique cwd with dedup + cache + omitted absent fields', async () => {
    gitState.responses.set('/repo/a', {
      branch: 'main',
      pullRequest: { number: 12, state: 'draft', url: 'https://example.com/pr/12' },
    });
    gitState.responses.set('/repo/b', { branch: 'fix/x', pullRequest: null });

    const page = await getData('?include=git');

    const byId = new Map(page.items.map((item) => [item.id, item as Session]));
    expect(byId.get('s1')?.git).toEqual({
      branch: 'main',
      pull_request: { number: 12, state: 'open', url: 'https://example.com/pr/12' },
    });
    expect(byId.get('s2')?.git?.branch).toBe('main');
    expect(byId.get('s3')?.git).toEqual({ branch: 'fix/x' });

    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);

    await getData('?include=git');
    expect(gitState.calls.toSorted()).toEqual(['/repo/a', '/repo/b']);
  });

  it('routes session git by environment even when local and remote cwds collide', async () => {
    const remoteRepo = await mkdtemp(join(tmpdir(), 'kimi-v1-session-git-remote-'));
    const remoteSummary: SessionSummary = {
      id: 'remote-git',
      workspaceId: WS_A,
      cwd: '/repo/remote-local',
      environmentId: 'dev-box',
      environmentCwd: remoteRepo,
      createdAt: 6_000,
      updatedAt: 6_000,
      archived: false,
    };
    const localShadow: SessionSummary = {
      id: 'local-shadow',
      workspaceId: WS_A,
      cwd: remoteRepo,
      createdAt: 5_500,
      updatedAt: 5_500,
      archived: false,
    };
    try {
      execFileSync('git', ['init'], { cwd: remoteRepo, stdio: ['ignore', 'pipe', 'pipe'] });
      const remoteBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: remoteRepo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      gitState.responses.set(remoteRepo, { branch: 'local-shadow', pullRequest: null });
      await (server as RunningServer).close();
      await bootSeeded([...SUMMARIES, localShadow, remoteSummary]);
      const registration = (server as RunningServer).core.accessor.get(IEnvironmentService).register(
        Object.assign(
          new FakeEnvironment(
            { environmentId: 'dev-box', generation: 'remote-generation' },
            { capabilities: ['fs', 'process'] },
          ),
          { fs: new HostFileSystem(), process: hostProcessWithoutGh() },
        ),
      );
      try {
        const page = await getData('?include=git');
        const byId = new Map(page.items.map((item) => [item.id, item as Session]));
        expect(byId.get('remote-git')?.git?.branch).toBe(remoteBranch);
        expect(byId.get('local-shadow')?.git?.branch).toBe('local-shadow');
        expect(gitState.calls.filter((cwd) => cwd === remoteRepo)).toHaveLength(1);

        await getData('?include=git');
        expect(gitState.calls.filter((cwd) => cwd === remoteRepo)).toHaveLength(1);
      } finally {
        await registration.remove();
      }
    } finally {
      await rm(remoteRepo, { recursive: true, force: true });
    }
  }, 15000);

  it('does not cache remote git while its environment is not ready', async () => {
    const remoteRepo = await mkdtemp(join(tmpdir(), 'kimi-v1-session-git-pending-'));
    const remoteSummary: SessionSummary = {
      id: 'remote-pending',
      workspaceId: WS_A,
      cwd: '/repo/remote-local',
      environmentId: 'dev-box',
      environmentCwd: remoteRepo,
      createdAt: 6_000,
      updatedAt: 6_000,
      archived: false,
    };
    try {
      execFileSync('git', ['init'], { cwd: remoteRepo, stdio: ['ignore', 'pipe', 'pipe'] });
      const remoteBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: remoteRepo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      await (server as RunningServer).close();
      await bootSeeded([...SUMMARIES, remoteSummary]);
      const environment = new FakeEnvironment(
        { environmentId: 'dev-box', generation: 'remote-generation' },
        { capabilities: ['fs', 'process'], status: 'connecting' },
      );
      const registration = (server as RunningServer).core.accessor.get(IEnvironmentService).register(
        Object.assign(environment, { fs: new HostFileSystem(), process: hostProcessWithoutGh() }),
      );
      try {
        const pending = await getData('?include=git');
        expect(
          (pending.items.find((item) => item.id === 'remote-pending') as Session | undefined)?.git,
        ).toEqual({});

        environment.setStatus('ready');
        const ready = await getData('?include=git');
        expect(
          (ready.items.find((item) => item.id === 'remote-pending') as Session | undefined)?.git
            ?.branch,
        ).toBe(remoteBranch);
      } finally {
        await registration.remove();
      }
    } finally {
      await rm(remoteRepo, { recursive: true, force: true });
    }
  }, 15000);

  it('times out a stalled remote git lookup without starting a second one', async () => {
    const remoteSummary: SessionSummary = {
      id: 'remote-stalled',
      workspaceId: WS_A,
      cwd: '/repo/remote-local',
      environmentId: 'dev-box',
      environmentCwd: '/remote/stalled',
      createdAt: 6_000,
      updatedAt: 6_000,
      archived: false,
    };
    let spawns = 0;
    let release: (() => void) | undefined;
    const released = new Promise<never>((_resolve, reject) => {
      release = () => reject(new Error('released'));
    });
    released.catch(() => {});
    const stalledProcess = {
      spawn: () => {
        spawns += 1;
        return released;
      },
    } as unknown as HostProcessService;
    await (server as RunningServer).close();
    await bootSeeded([...SUMMARIES, remoteSummary]);
    const registration = (server as RunningServer).core.accessor.get(IEnvironmentService).register(
      Object.assign(
        new FakeEnvironment(
          { environmentId: 'dev-box', generation: 'remote-generation' },
          { capabilities: ['fs', 'process'] },
        ),
        { fs: new HostFileSystem(), process: stalledProcess },
      ),
    );
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const page = await getData('?include=git');
        expect(
          (page.items.find((item) => item.id === 'remote-stalled') as Session | undefined)?.git,
        ).toEqual({});
      }
      expect(spawns).toBe(1);
    } finally {
      release?.();
      await registration.remove();
    }
  }, 20000);

  it('degrades non-git cwds to an empty git object without failing the request', async () => {
    await (server as RunningServer).close();
    await bootSeeded();
    const page = await getData('?include=git&archived=all');
    for (const item of page.items) {
      expect((item as Session).git).toEqual({});
    }
  });

  it('requires bearer auth on /api/v1/sessions', async () => {
    const unauthed = await fetch(`${base}/api/v1/sessions`);
    expect(unauthed.status).toBe(401);
    const body = (await unauthed.json()) as { code: number };
    expect(body.code).toBe(40101);

    const authed = await fetch(`${base}/api/v1/sessions`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    expect(authed.status).toBe(200);
  });

  it('groups the matching set per workspace with per-group totals (view=by_workspace)', async () => {
    const page = await getGroupData('?view=by_workspace');
    expect(page.total).toBe(2);
    expect(page.has_more).toBe(false);
    expect(page.next_page_token).toBeUndefined();

    expect(page.groups.map((group) => group.workspace_id)).toEqual([WS_A, WS_B]);
    const [a, b] = page.groups as [GroupWire, GroupWire];
    expect(a.workspace_id).toBe(WS_A);
    expect(a.sessions.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(a.total).toBe(2);
    expect(b.workspace_id).toBe(WS_B);
    expect(b.sessions.map((item) => item.id)).toEqual(['s3']);
    expect(b.total).toBe(1);

    const first = a.sessions[0] as Session;
    expect(first.last_prompt).toBe('do alpha');
    expect(first.metadata.cwd).toBe('/repo/a');
    expect('git' in first).toBe(false);
  });

  it('caps each group at group_page_size while total keeps the full matching count', async () => {
    const page = await getGroupData('?view=by_workspace&group_page_size=1');
    const [a, b] = page.groups as [GroupWire, GroupWire];
    expect(a.sessions.map((item) => item.id)).toEqual(['s1']);
    expect(a.total).toBe(2);
    expect(b.sessions.map((item) => item.id)).toEqual(['s3']);
    expect(b.total).toBe(1);
  });

  it('filters empty vs non-empty sessions via has_prompt', async () => {
    const flat = await getData('?has_prompt=true');
    expect(flat.items.map((item) => item.id)).toEqual(['s1', 's2']);

    const inverted = await getData('?has_prompt=false');
    expect(inverted.items.map((item) => item.id)).toEqual(['s3']);

    const grouped = await getGroupData('?view=by_workspace&has_prompt=true');
    expect(grouped.groups.map((group) => group.workspace_id)).toEqual([WS_A]);
    expect(grouped.groups[0]?.sessions.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(grouped.groups[0]?.total).toBe(2);
  });

  it('applies sort, workspace_id, and archived to groups with flat-view semantics', async () => {
    const asc = await getGroupData('?view=by_workspace&sort=updated_at_asc');
    expect(asc.groups.map((group) => group.workspace_id)).toEqual([WS_B, WS_A]);
    expect(asc.groups[1]?.sessions.map((item) => item.id)).toEqual(['s2', 's1']);

    const filtered = await getGroupData(`?view=by_workspace&workspace_id=${WS_B}`);
    expect(filtered.groups.map((group) => group.workspace_id)).toEqual([WS_B]);
    expect(filtered.total).toBe(1);

    const all = await getGroupData('?view=by_workspace&archived=all');
    const b = all.groups.find((group) => group.workspace_id === WS_B);
    expect(b?.sessions.map((item) => item.id)).toEqual(['s3', 's4']);
    expect(b?.total).toBe(2);
  });

  it('paginates groups with the opaque cursor and rejects condition drift (40922)', async () => {
    const page1 = await getGroupData('?view=by_workspace&page_size=1');
    expect(page1.groups.map((group) => group.workspace_id)).toEqual([WS_A]);
    expect(page1.total).toBe(2);
    expect(page1.has_more).toBe(true);

    const page2 = await getGroupData(
      `?view=by_workspace&page_size=1&page_token=${page1.next_page_token}`,
    );
    expect(page2.groups.map((group) => group.workspace_id)).toEqual([WS_B]);
    expect(page2.total).toBe(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_page_token).toBeUndefined();

    for (const drifted of [
      `?view=by_workspace&page_size=1&group_page_size=2&page_token=${page1.next_page_token}`,
      `?view=by_workspace&page_size=1&has_prompt=true&page_token=${page1.next_page_token}`,
      `?page_size=1&page_token=${page1.next_page_token}`,
    ]) {
      expect((await getError(drifted)).code).toBe(40922);
    }
  });

  it('paginates groups by 1-based page without minting tokens', async () => {
    const page2 = await getGroupData('?view=by_workspace&page=2&page_size=1');
    expect(page2.groups.map((group) => group.workspace_id)).toEqual([WS_B]);
    expect(page2.total).toBe(2);
    expect(page2.has_more).toBe(false);
    expect(page2.next_page_token).toBeUndefined();

    const beyond = await getGroupData('?view=by_workspace&page=7&page_size=1');
    expect(beyond.groups).toEqual([]);
    expect(beyond.total).toBe(2);
  });

  it('supports the ids projection and include=git inside groups', async () => {
    await (server as RunningServer).close();
    await bootSeeded();
    const projected = await getGroupData('?view=by_workspace&fields=id,archived');
    expect(projected.groups[0]?.sessions).toEqual([
      { id: 's1', archived: false },
      { id: 's2', archived: false },
    ]);

    gitState.responses.set('/repo/a', { branch: 'main', pullRequest: null });
    const withGit = await getGroupData('?view=by_workspace&include=git');
    const s1 = withGit.groups[0]?.sessions.find((item) => item.id === 's1') as Session;
    expect(s1.git).toEqual({ branch: 'main' });
    const s3 = withGit.groups[1]?.sessions.find((item) => item.id === 's3') as Session;
    expect(s3.git).toEqual({});
  });

  it('rejects group_page_size without the grouped view or beyond the ceiling (40001)', async () => {
    expect((await getError('?group_page_size=5')).code).toBe(40001);
    expect((await getError('?view=by_workspace&group_page_size=0')).code).toBe(40001);
    expect((await getError('?view=by_workspace&group_page_size=101')).code).toBe(40001);
    expect((await getError('?view=by_workspace&group_page_size=abc')).code).toBe(40001);

    const projected = await getGroupData(
      '?view=by_workspace&fields=id,archived&group_page_size=10000',
    );
    expect(projected.total).toBe(2);
    expect(
      (await getError('?view=by_workspace&fields=id,archived&group_page_size=10001')).code,
    ).toBe(40001);
  });

  it('merges legacy split workspace ids into one group via alias canonicalization', async () => {
    await (server as RunningServer).close();
    const legacyAlias = 'wd_aaa.legacy_000000000000';
    const aliasSummaries: SessionSummary[] = [
      ...SUMMARIES,
      {
        id: 's5',
        workspaceId: legacyAlias,
        title: 'Legacy bucket without persisted cwd',
        lastPrompt: 'legacy one',
        createdAt: 6_000,
        updatedAt: 6_000,
        archived: false,
      },
    ];
    const aliasStub: IWorkspaceAliases = {
      _serviceBrand: undefined,
      resolveAliasIds: async (id) =>
        id === WS_A || id === legacyAlias ? [WS_A, legacyAlias] : [id],
    };
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      seeds: [
        [ISessionIndex, stubSessionIndex(aliasSummaries)],
        [IWorkspaceService, workspaceStub],
        [IGitService, gitStub],
        [IWorkspaceAliases, aliasStub],
      ],
    });
    base = `http://127.0.0.1:${server.port}`;

    const page = await getGroupData('?view=by_workspace');
    expect(page.total).toBe(2);
    const merged = page.groups.find((group) => group.workspace_id === WS_A);
    expect(merged?.sessions.map((item) => item.id)).toEqual(['s5', 's1', 's2']);
    expect((merged?.sessions[0] as Session | undefined)?.metadata.cwd).toBe('/repo/a');
    expect(merged?.total).toBe(3);
  });
});

describe('server /api/v1/sessions batch archive/restore', () => {
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

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v1-sessions-batch-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
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
    const res = await authedFetch(server as RunningServer, base, `/api/v1/sessions${query}`);
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

    const body = await postBatch('/api/v1/sessions:archive', { ids: [created.id] });
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
    expect(await listedIds('?archived=true')).toEqual([created.id]);
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

    const body = await postBatch('/api/v1/sessions:archive', { ids: [created.id] });
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
    const batchPromise = postBatch('/api/v1/sessions:archive', { ids: [created.id] });

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

    const body = await postBatch('/api/v1/sessions:archive', {
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

  it('restores a cold session without materializing it and publishes a restored event', async () => {
    const created = await createSession();
    await closeSessionById(core(), created.id);
    await postBatch('/api/v1/sessions:archive', { ids: [created.id] });
    expect(await indexArchived(created.id)).toBe(true);

    const { events, dispose } = collectEvents();
    const before = await readStateJson(created.workspace_id, created.id);
    const archivedWhenAnnounced: Promise<boolean | undefined>[] = [];
    const announced = core().get(IEventService).subscribe((event) => {
      if (event.type === 'event.session.restored') archivedWhenAnnounced.push(indexArchived(created.id));
    });

    const body = await postBatch('/api/v1/sessions:restore', { ids: [created.id] });
    announced.dispose();
    expect(await Promise.all(archivedWhenAnnounced)).toEqual([false]);
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
    expect(
      events
        .filter((event) => event.type === 'event.session.restored')
        .map((event) => (event as { readonly payload?: unknown }).payload),
    ).toEqual([{ sessionId: created.id, workspaceId: created.workspace_id }]);

    const { events: again, dispose: disposeAgain } = collectEvents();
    await postBatch('/api/v1/sessions:restore', { ids: [created.id] });
    expect(again.filter((event) => event.type === 'event.session.restored')).toEqual([]);
    disposeAgain();
    dispose();
  });

  it('restores a live session through the lifecycle chain and keeps it live', async () => {
    const created = await createSession();
    await postBatch('/api/v1/sessions:archive', { ids: [created.id] });
    expect(await resumeSessionById(core(), created.id)).toBeDefined();
    const { events, dispose } = collectEvents();
    const archivedWhenAnnounced: Promise<boolean | undefined>[] = [];
    const announced = core().get(IEventService).subscribe((event) => {
      if (event.type === 'event.session.restored') archivedWhenAnnounced.push(indexArchived(created.id));
    });

    const body = await postBatch('/api/v1/sessions:restore', { ids: [created.id] });
    announced.dispose();
    expect(await Promise.all(archivedWhenAnnounced)).toEqual([false]);
    expect(body.code).toBe(0);
    expect(body.data?.results).toEqual([{ id: created.id, ok: true }]);

    expect(getLiveSessionById(core(), created.id)).toBeDefined();
    expect(await indexArchived(created.id)).toBe(false);
    expect(
      events
        .filter((event) => event.type === 'event.session.restored')
        .map((event) => (event as { readonly payload?: unknown }).payload),
    ).toEqual([{ sessionId: created.id, workspaceId: created.workspace_id }]);
    dispose();
  });

  it('validates the batch body: empty, missing, over the unique cap, duplicates', async () => {
    for (const body of [{ ids: [] }, {}]) {
      const rejected = await postBatch('/api/v1/sessions:archive', body);
      expect(rejected.code).toBe(40001);
      expect(rejected.data).toBeNull();
    }

    const tooMany = await postBatch('/api/v1/sessions:archive', {
      ids: Array.from({ length: 5001 }, (_, i) => `sess_${i}`),
    });
    expect(tooMany.code).toBe(40001);

    const deduped = await postBatch('/api/v1/sessions:archive', {
      ids: Array.from({ length: 5001 }, () => 'sess_dup'),
    });
    expect(deduped.code).toBe(0);
    expect(deduped.data?.results).toHaveLength(1);
    expect(deduped.data?.results[0]?.ok).toBe(false);
    expect(deduped.data?.results[0]?.error?.code).toBe(40401);
  });
});

describe('mapSessionActivity', () => {
  it('classifies main turn vs background work vs idle', () => {
    expect(
      mapSessionActivity({ busy: false, mainTurnActive: false, pendingInteraction: 'none' }),
    ).toBe('idle');
    expect(
      mapSessionActivity({ busy: true, mainTurnActive: false, pendingInteraction: 'none' }),
    ).toBe('background');
    expect(
      mapSessionActivity({ busy: true, mainTurnActive: true, pendingInteraction: 'none' }),
    ).toBe('turn');
  });
});
