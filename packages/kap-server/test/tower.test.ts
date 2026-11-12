import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const activityReadControl = vi.hoisted(() => ({
  gate: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('@moonshot-ai/agent-core-v2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/agent-core-v2')>();
  return {
    ...actual,
    readTowerLogFrom: async (repoRoot: string, offset: number) => {
      const gate = activityReadControl.gate;
      activityReadControl.gate = undefined;
      if (gate !== undefined) await gate();
      return actual.readTowerLogFrom(repoRoot, offset);
    },
  };
});

interface InjectResponse {
  statusCode: number;
  json: () => unknown;
}

interface AppLike {
  inject: (req: unknown) => Promise<InjectResponse>;
}

interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
}

interface TowerProjectionWire {
  status: 'uninitialized' | 'lost' | 'off' | 'active';
  has_content: boolean;
  base?: string;
  mode?: 'branch' | 'pr';
  recovered_at?: string;
  mission_counts: {
    planned: number;
    active: number;
    completed: number;
    blocked: number;
    paused: number;
    merged: number;
    abandoned: number;
  };
  workers_live: number;
  reviewers_live: number;
  roster_total: number;
  open_missions: {
    id: string;
    title: string;
    kind: 'build' | 'survey';
    status: 'planned' | 'active' | 'completed' | 'blocked' | 'paused' | 'merged' | 'abandoned';
    owner?: string;
    branch: string;
    scope: string[];
    tasks_done: number;
    tasks_total: number;
    blockers: number;
    latest_note_preview?: string;
    live_workers: number;
  }[];
  recent_closed: {
    id: string;
    title: string;
    status: 'merged' | 'abandoned';
    closed_at?: string;
  }[];
  events: {
    at: string;
    actor: string;
    kind: string;
    fields: Record<string, string>;
  }[];
  log_offset: number;
}

const ACTIVITY_LOG_LINES = [
  '2026-01-01T00:01:00.000Z tower spawn name=worker-a mission=M1 branch=feat/add-feature',
  '2026-01-01T00:01:30.000Z worker-a mission.update id=M1 status=active note=added',
  '2026-01-01T00:03:00.000Z tower merge branch=feat/ship-it commit=abc1234',
  '2026-01-01T00:04:00.000Z worker-a inbox.send to=tower subject=status',
];

function appOf(r: RunningServer): AppLike {
  const app = r.app as unknown as AppLike;
  return {
    inject(req: unknown): Promise<InjectResponse> {
      const request = req as { headers?: Record<string, string> };
      return app.inject({
        ...request,
        headers: {
          ...request.headers,
          authorization: `Bearer ${r.authTokenService.getToken()}`,
        },
      });
    },
  };
}

function envelopeOf<T>(body: unknown): Envelope<T> {
  return body as Envelope<T>;
}

async function createWorkspace(api: AppLike, root: string): Promise<string> {
  const res = await api.inject({
    method: 'POST',
    url: '/api/v1/workspaces',
    payload: { root },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  expect(env.code).toBe(0);
  return (env.data as { id: string }).id;
}

function getTower(api: AppLike, workspaceId: string): Promise<InjectResponse> {
  return api.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceId}/tower` });
}

async function writeTowerFixture(root: string): Promise<void> {
  const comms = join(root, '.tower', 'comms');
  await mkdir(join(comms, 'log'), { recursive: true });
  const state = {
    version: 1,
    base: 'main',
    mode: 'branch',
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: 's1',
    roster: {
      agents: [
        {
          name: 'worker-a',
          agentId: 'a1',
          kind: 'worker',
          missionId: 'M1',
          spawnedAt: '2026-01-01T00:01:00.000Z',
        },
        {
          name: 'worker-zombie',
          agentId: 'a2',
          kind: 'worker',
          missionId: 'M1',
          spawnedAt: '2026-01-01T00:01:00.000Z',
          diedAt: '2026-01-01T00:02:00.000Z',
        },
      ],
    },
    missions: [
      {
        id: 'M1',
        title: 'Add feature',
        slug: 'add-feature',
        kind: 'build',
        scope: ['src/feature'],
        branch: 'feat/add-feature',
        worktree: 'wt-1',
        deps: [],
        status: 'active',
        owner: 'worker-a',
        tasks: [
          { text: 'implement', done: true },
          { text: 'test', done: false },
        ],
        notes: ['halfway there'],
        blockers: [],
      },
      {
        id: 'M2',
        title: 'Ship it',
        slug: 'ship-it',
        kind: 'build',
        scope: ['src/ship'],
        branch: 'feat/ship-it',
        worktree: 'wt-2',
        deps: [],
        status: 'merged',
        tasks: [{ text: 'land', done: true }],
        notes: [],
        blockers: [],
      },
    ],
  };
  await writeFile(join(comms, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await writeFile(
    join(comms, 'log', 'activity.log'),
    `${ACTIVITY_LOG_LINES.join('\n')}\n`,
    'utf8',
  );
}

describe('server-v2 /api/v1/workspaces/{workspace_id}/tower', () => {
  let home: string | undefined;
  let fixtureRoot: string | undefined;
  let emptyRoot: string | undefined;
  let server: RunningServer | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tower-home-'));
    fixtureRoot = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tower-repo-'));
    emptyRoot = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tower-empty-'));
    await writeTowerFixture(fixtureRoot);
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const dir of [home, fixtureRoot, emptyRoot]) {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
    home = undefined;
    fixtureRoot = undefined;
    emptyRoot = undefined;
  });

  it('returns the tower projection with the snake_case wire shape', async () => {
    const api = appOf(server as RunningServer);
    const workspaceId = await createWorkspace(api, fixtureRoot as string);

    const res = await getTower(api, workspaceId);
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<TowerProjectionWire>(res.json());
    expect(env.code).toBe(0);
    const data = env.data as TowerProjectionWire;

    expect(data.status).toBe('active');
    expect(data.has_content).toBe(true);
    expect(data.base).toBe('main');
    expect(data.mode).toBe('branch');
    expect(data.mission_counts).toEqual({
      planned: 0,
      active: 1,
      completed: 0,
      blocked: 0,
      paused: 0,
      merged: 1,
      abandoned: 0,
    });
    expect(data.workers_live).toBe(1);
    expect(data.reviewers_live).toBe(0);
    expect(data.roster_total).toBe(2);
    expect(data.open_missions).toHaveLength(1);

    const mission = data.open_missions[0] as TowerProjectionWire['open_missions'][number];
    expect(mission.id).toBe('M1');
    expect(mission.title).toBe('Add feature');
    expect(mission.kind).toBe('build');
    expect(mission.status).toBe('active');
    expect(mission.owner).toBe('worker-a');
    expect(mission.branch).toBe('feat/add-feature');
    expect(mission.scope).toEqual(['src/feature']);
    expect(mission.tasks_done).toBe(1);
    expect(mission.tasks_total).toBe(2);
    expect(mission.blockers).toBe(0);
    expect(mission.latest_note_preview).toBe('halfway there');
    expect(mission.live_workers).toBe(1);

    expect(data.recent_closed).toHaveLength(1);
    expect(data.recent_closed[0]).toMatchObject({
      id: 'M2',
      title: 'Ship it',
      status: 'merged',
      closed_at: '2026-01-01T00:03:00.000Z',
    });

    expect(data.events).toHaveLength(3);
    expect(data.events.some((event) => event.kind === 'inbox.send')).toBe(false);
    expect(data.events.find((event) => event.kind === 'mission.update')?.fields).toEqual({
      id: 'M1',
      status: 'active',
      note: 'added',
    });
    expect(typeof data.log_offset).toBe('number');
    expect(data.log_offset).toBeGreaterThan(0);

    const raw = data as unknown as Record<string, unknown>;
    expect(raw['hasContent']).toBeUndefined();
    expect(raw['missionCounts']).toBeUndefined();
    expect(raw['workersLive']).toBeUndefined();
    expect(raw['openMissions']).toBeUndefined();
    expect(raw['recentClosed']).toBeUndefined();
    expect(raw['logOffset']).toBeUndefined();
  });

  it('returns 40410 for an unknown workspace', async () => {
    const api = appOf(server as RunningServer);
    const res = await getTower(api, 'wd_missing_000000000000');
    const env = envelopeOf<null>(res.json());
    expect(env.code).toBe(40410);
    expect(env.data).toBeNull();
  });

  it('reports uninitialized for a workspace without a .tower directory', async () => {
    const api = appOf(server as RunningServer);
    const workspaceId = await createWorkspace(api, emptyRoot as string);

    const res = await getTower(api, workspaceId);
    expect(res.statusCode).toBe(200);
    const env = envelopeOf<TowerProjectionWire>(res.json());
    expect(env.code).toBe(0);
    const data = env.data as TowerProjectionWire;

    expect(data.status).toBe('uninitialized');
    expect(data.has_content).toBe(false);
    expect(data.base).toBeUndefined();
    expect(data.mode).toBeUndefined();
    expect(data.mission_counts).toEqual({
      planned: 0,
      active: 0,
      completed: 0,
      blocked: 0,
      paused: 0,
      merged: 0,
      abandoned: 0,
    });
    expect(data.open_missions).toEqual([]);
    expect(data.recent_closed).toEqual([]);
    expect(data.events).toEqual([]);
    expect(data.log_offset).toBe(0);
  });
});

interface ServerFrame {
  type?: string;
  id?: string;
  request_id?: string;
  code?: number;
  msg?: string;
  payload?: Record<string, unknown>;
}

interface TowerEventWire {
  at: string;
  actor: string;
  kind: string;
  fields: Record<string, string>;
}

interface TowerStateFrame {
  type: 'tower.state';
  payload: {
    workspace_id: string;
    status: string;
    base?: string;
    log_offset: number;
    events: TowerEventWire[];
  };
}

interface TowerActivityFrame {
  type: 'tower.activity';
  payload: {
    workspace_id: string;
    events: TowerEventWire[];
    offset: number;
  };
}

interface TowerResponseFrame {
  type: 'response';
  request_id: string;
  code: number;
  msg?: string;
}

interface WsHarness {
  readonly ws: WebSocket;
  readonly frames: ServerFrame[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFrame(
  frames: ServerFrame[],
  predicate: (frame: ServerFrame) => boolean,
  timeoutMs = 5000,
): Promise<ServerFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() >= deadline) {
      throw new Error(`frame not received within ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

async function openTowerWs(server: RunningServer): Promise<WsHarness> {
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/ws`, [
    `kimi-code.bearer.${server.authTokenService.getToken()}`,
  ]);
  const frames: ServerFrame[] = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse((data as Buffer).toString()) as ServerFrame);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames };
}

function sendTowerControl(
  client: WsHarness,
  type: 'tower.subscribe' | 'tower.unsubscribe',
  id: string,
  workspaceId: string,
): void {
  client.ws.send(JSON.stringify({ type, request_id: id, workspace_id: workspaceId }));
}

function sendTowerSubscribe(client: WsHarness, id: string, workspaceId: string): void {
  sendTowerControl(client, 'tower.subscribe', id, workspaceId);
}

function sendTowerUnsubscribe(client: WsHarness, id: string, workspaceId: string): void {
  sendTowerControl(client, 'tower.unsubscribe', id, workspaceId);
}

async function rewriteTowerState(root: string): Promise<void> {
  const statePath = join(root, '.tower', 'comms', 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, unknown>;
  state['sessionId'] = 's2';
  state['base'] = 'main-s2';
  const tmp = `${statePath}.tmp.${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, statePath);
}

function appendTowerActivity(root: string, line: string): Promise<void> {
  return appendFile(join(root, '.tower', 'comms', 'log', 'activity.log'), `${line}\n`, 'utf8');
}

describe('server-v2 /api/v1/ws tower subscriptions', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  const roots: string[] = [];
  const clients: WsHarness[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tower-ws-home-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
  });

  async function createTowerWorkspace(api: AppLike): Promise<{ root: string; workspaceId: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kimi-server-v2-tower-ws-'));
    roots.push(root);
    await writeTowerFixture(root);
    const workspaceId = await createWorkspace(api, root);
    return { root, workspaceId };
  }

  async function connect(): Promise<WsHarness> {
    const client = await openTowerWs(server as RunningServer);
    clients.push(client);
    return client;
  }

  afterAll(async () => {
    for (const client of clients.splice(0)) client.ws.close();
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('pushes a full tower.state snapshot after tower.subscribe', async () => {
    const api = appOf(server as RunningServer);
    const { workspaceId } = await createTowerWorkspace(api);
    const client = await connect();

    sendTowerSubscribe(client, 'sub-1', workspaceId);

    const response = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'response' && frame.request_id === 'sub-1',
    )) as TowerResponseFrame;
    expect(response.code).toBe(0);

    const state = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'tower.state',
    )) as TowerStateFrame;
    expect(state.payload.workspace_id).toBe(workspaceId);
    expect(state.payload.status).toBe('active');
    expect(state.payload.events.some((event) => event.kind === 'inbox.send')).toBe(false);
    expect(state.payload.log_offset).toBeGreaterThan(0);
    expect(client.frames.indexOf(response)).toBeLessThan(client.frames.indexOf(state));
  });

  it('pushes tower.activity with the appended whitelisted event and a later offset', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    const client = await connect();

    sendTowerSubscribe(client, 'sub-1', workspaceId);
    const state = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'tower.state',
    )) as TowerStateFrame;

    await appendTowerActivity(
      root,
      '2026-01-01T00:10:00.000Z tower spawn name=worker-b mission=M1 branch=feat/add-feature',
    );

    const activity = (await waitForFrame(
      client.frames,
      (frame) =>
        frame.type === 'tower.activity' &&
        ((frame.payload?.['events'] as TowerEventWire[] | undefined) ?? []).some(
          (event) => event.kind === 'spawn' && event.fields['name'] === 'worker-b',
        ),
    )) as TowerActivityFrame;
    const spawn = activity.payload.events.find(
      (event) => event.kind === 'spawn' && event.fields['name'] === 'worker-b',
    );
    expect(spawn).toBeDefined();
    expect(spawn?.fields['mission']).toBe('M1');
    expect(activity.payload.workspace_id).toBe(workspaceId);
    expect(activity.payload.offset).toBeGreaterThan(state.payload.log_offset);
  });

  it('does not push tower.activity for lines outside the whitelist', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    const client = await connect();

    sendTowerSubscribe(client, 'sub-1', workspaceId);
    await waitForFrame(client.frames, (frame) => frame.type === 'tower.state');

    const activityBefore = client.frames.filter((frame) => frame.type === 'tower.activity').length;
    await appendTowerActivity(root, '2026-01-01T00:11:00.000Z worker-a inbox.send to=tower subject=status');
    await sleep(800);

    const activityAfter = client.frames.filter((frame) => frame.type === 'tower.activity').length;
    expect(activityAfter).toBe(activityBefore);
  });

  it('pushes a new tower.state after state.json is rewritten', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    const client = await connect();

    sendTowerSubscribe(client, 'sub-1', workspaceId);
    await waitForFrame(client.frames, (frame) => frame.type === 'tower.state');
    client.frames.length = 0;

    await rewriteTowerState(root);

    const state = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'tower.state',
    )) as TowerStateFrame;
    expect(state.payload.workspace_id).toBe(workspaceId);
    expect(state.payload.status).toBe('active');
    expect(state.payload.base).toBe('main-s2');
  });

  it('rejects tower.subscribe for an unknown workspace with 40410', async () => {
    const client = await connect();
    const missing = 'wd_missing_000000000000';

    sendTowerSubscribe(client, 'sub-missing', missing);

    const response = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'response' && frame.request_id === 'sub-missing',
    )) as TowerResponseFrame;
    expect(response.code).toBe(40410);
  });

  it('rejects tower.subscribe when the initial projection cannot be read', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    await writeFile(join(root, '.tower', 'comms', 'state.json'), '{broken\n', 'utf8');
    const client = await connect();

    sendTowerSubscribe(client, 'sub-broken', workspaceId);

    const response = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'response' && frame.request_id === 'sub-broken',
    )) as TowerResponseFrame;
    expect(response.code).not.toBe(0);
    expect(client.frames.filter((frame) => frame.type === 'tower.state')).toEqual([]);
  });

  it('stops pushing after tower.unsubscribe', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    const client = await connect();

    sendTowerSubscribe(client, 'sub-1', workspaceId);
    await waitForFrame(client.frames, (frame) => frame.type === 'tower.state');
    sendTowerUnsubscribe(client, 'unsub-1', workspaceId);
    const response = (await waitForFrame(
      client.frames,
      (frame) => frame.type === 'response' && frame.request_id === 'unsub-1',
    )) as TowerResponseFrame;
    expect(response.code).toBe(0);
    client.frames.length = 0;

    await appendTowerActivity(
      root,
      '2026-01-01T00:12:00.000Z tower spawn name=worker-c mission=M1 branch=feat/add-feature',
    );
    await sleep(800);

    expect(client.frames.filter((frame) => frame.type === 'tower.activity')).toEqual([]);
  });

  it('fans out to multiple subscribers and keeps the remaining one after unsubscribe', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    const first = await connect();
    const second = await connect();

    sendTowerSubscribe(first, 'sub-a', workspaceId);
    sendTowerSubscribe(second, 'sub-b', workspaceId);
    await waitForFrame(first.frames, (frame) => frame.type === 'tower.state');
    await waitForFrame(second.frames, (frame) => frame.type === 'tower.state');

    await appendTowerActivity(
      root,
      '2026-01-01T00:13:00.000Z tower spawn name=worker-d mission=M1 branch=feat/add-feature',
    );
    await waitForFrame(
      first.frames,
      (frame) =>
        frame.type === 'tower.activity' &&
        ((frame.payload?.['events'] as TowerEventWire[] | undefined) ?? []).some(
          (event) => event.fields['name'] === 'worker-d',
        ),
    );
    await waitForFrame(
      second.frames,
      (frame) =>
        frame.type === 'tower.activity' &&
        ((frame.payload?.['events'] as TowerEventWire[] | undefined) ?? []).some(
          (event) => event.fields['name'] === 'worker-d',
        ),
    );

    sendTowerUnsubscribe(first, 'unsub-a', workspaceId);
    const response = (await waitForFrame(
      first.frames,
      (frame) => frame.type === 'response' && frame.request_id === 'unsub-a',
    )) as TowerResponseFrame;
    expect(response.code).toBe(0);
    first.frames.length = 0;

    await appendTowerActivity(
      root,
      '2026-01-01T00:14:00.000Z tower spawn name=worker-e mission=M1 branch=feat/add-feature',
    );
    await waitForFrame(
      second.frames,
      (frame) =>
        frame.type === 'tower.activity' &&
        ((frame.payload?.['events'] as TowerEventWire[] | undefined) ?? []).some(
          (event) => event.fields['name'] === 'worker-e',
        ),
    );
    await sleep(500);

    expect(first.frames.filter((frame) => frame.type === 'tower.activity')).toEqual([]);
  });

  it('keeps a new subscriber baseline ahead of older in-flight activity', async () => {
    const api = appOf(server as RunningServer);
    const { root, workspaceId } = await createTowerWorkspace(api);
    const first = await connect();
    sendTowerSubscribe(first, 'sub-first', workspaceId);
    await waitForFrame(first.frames, (frame) => frame.type === 'tower.state');

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    activityReadControl.gate = async () => {
      markStarted();
      await blocked;
    };
    const second = await connect();
    try {
      await appendTowerActivity(
        root,
        '2026-01-01T00:15:00.000Z tower spawn name=worker-queued mission=M1 branch=feat/add-feature',
      );
      await started;
      sendTowerSubscribe(second, 'sub-second', workspaceId);
      const response = (await waitForFrame(
        second.frames,
        (frame) => frame.type === 'response' && frame.request_id === 'sub-second',
      )) as TowerResponseFrame;
      expect(response.code).toBe(0);
      release();

      await waitForFrame(
        first.frames,
        (frame) =>
          frame.type === 'tower.activity' &&
          ((frame.payload?.['events'] as TowerEventWire[] | undefined) ?? []).some(
            (event) => event.fields['name'] === 'worker-queued',
          ),
      );
      const state = (await waitForFrame(
        second.frames,
        (frame) => frame.type === 'tower.state',
      )) as TowerStateFrame;

      expect(state.payload.events.some((event) => event.fields['name'] === 'worker-queued')).toBe(
        true,
      );
      expect(second.frames.filter((frame) => frame.type === 'tower.activity')).toEqual([]);
      expect(second.frames.indexOf(response)).toBeLessThan(second.frames.indexOf(state));
    } finally {
      release();
      activityReadControl.gate = undefined;
    }
  });
});
