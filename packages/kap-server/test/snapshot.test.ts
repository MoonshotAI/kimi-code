import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Event2,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  IAppendLogStore,
  IEventBus,
  IAgentLifecycleService,
  IAgentPromptService,
  ISessionInteractionService,
  ISessionContext,
  ISessionIndex,
  ISessionMetadata,
  ISessionLifecycleService,
  IWireService,
  ISessionManager,
  ITelemetryService,
  IWorkspaceService,
  getLiveSessionById,
  resumeSessionById,
} from '@moonshot-ai/agent-core-v2';
import { sessionSnapshotResponseSchema } from '../src/protocol/rest-snapshot';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSnapshotRoutes } from '../src/routes/snapshot';
import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

function fakeAccessor(entries: ReadonlyArray<readonly [unknown, unknown]>) {
  const services = new Map<unknown, unknown>(entries);
  return {
    get<T>(id: unknown): T {
      if (!services.has(id)) {
        throw new Error(`unexpected service request: ${String(id)}`);
      }
      return services.get(id) as T;
    },
  };
}

describe('server-v2 snapshot route enrichment', () => {
  it('attaches current_prompt_id to an in-flight turn from prompt active state', async () => {
    const sessionId = 'sess_snapshot';
    const promptId = 'msg_snapshot_prompt';
    const workspaceId = 'wd_snapshot_012345abcdef';
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const main = {
      accessor: fakeAccessor([
        [IAgentContextMemoryService, { get: () => [] }],
        [
          IAgentPromptService,
          { list: () => ({ active: { id: promptId }, pending: [] }) },
        ],
        [IWireService, { flush: async () => {} }],
        [IAgentScopeContext, { scope: () => 'scope/sess_snapshot' }],
        [IAgentBlobService, { loadParts: async (parts: unknown) => parts }],
      ]),
    };
    const session = {
      accessor: fakeAccessor([
        [ISessionContext, { workspaceId }],
        [
          ISessionMetadata,
          {
            read: async () => ({
              id: sessionId,
              title: 'Snapshot',
              createdAt: now,
              updatedAt: now,
              archived: false,
            }),
          },
        ],
        [IAgentLifecycleService, { get: () => main, create: async () => main }],
        [ISessionInteractionService, { listPending: () => [] }],
      ]),
    };
    const handler = {
      accessor: fakeAccessor([
        [
          ISessionLifecycleService,
          { resume: async () => session, get: () => undefined },
        ],
      ]),
    };
    const core = {
      accessor: fakeAccessor([
        [
          ISessionIndex,
          {
            get: async () => ({
              id: sessionId,
              workspaceId,
              cwd: '/workspace',
              createdAt: now,
              updatedAt: now,
              archived: false,
            }),
          },
        ],
        [
          ISessionManager,
          {
            resume: async () => session,
            get: () => undefined,
            list: () => [],
          },
        ],
        [IWorkspaceService, { get: async () => ({ root: '/workspace' }) }],
        [ITelemetryService, { withContext: () => ({ track2: () => {} }) }],
        [
          IAppendLogStore,
          {
            read: async function* () {},
          },
        ],
      ]),
    };
    const broadcaster = {
      getSnapshotState: async () => ({
        seq: 1,
        epoch: 'ep_snapshot',
        inFlightTurn: {
          turn_id: 7,
          assistant_text: 'Hello',
          thinking_text: '',
          running_tools: [],
        },
        subagents: [
          {
            id: 'agent-1',
            session_id: sessionId,
            kind: 'subagent',
            description: 'task agent-1',
            status: 'running',
            subagent_phase: 'working',
            parent_tool_call_id: 'tc_swarm_1',
            swarm_index: 0,
            run_in_background: false,
            created_at: new Date(now).toISOString(),
          },
        ],
      }),
    };

    let routeHandler:
      | ((
          req: { id: string; params: { session_id: string } },
          reply: { send(payload: unknown): unknown },
        ) => Promise<void> | void)
      | undefined;
    registerSnapshotRoutes(
      {
        get: (_path, _options, handler) => {
          routeHandler = handler;
        },
      },
      {
        core: core as never,
        broadcaster: broadcaster as never,
      },
    );

    let payload: unknown;
    await routeHandler?.(
      { id: 'req_snapshot', params: { session_id: sessionId } },
      {
        send: (value) => {
          payload = value;
        },
      },
    );

    const body = payload as { code: number; data: unknown };
    expect(body.code).toBe(0);
    const snap = sessionSnapshotResponseSchema.parse(body.data);
    expect(snap.in_flight_turn).toMatchObject({
      turn_id: 7,
      assistant_text: 'Hello',
      current_prompt_id: promptId,
    });
    expect(snap.subagents).toEqual([
      expect.objectContaining({
        id: 'agent-1',
        kind: 'subagent',
        subagent_phase: 'working',
        parent_tool_call_id: 'tc_swarm_1',
        swarm_index: 0,
        run_in_background: false,
      }),
    ]);
  });
});

describe('server-v2 GET /api/v1/sessions/:id/snapshot', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-snapshot-test-'));
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home } }),
    } as never);
    const body = (await res.json()) as { code: number; data: { id: string } };
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function ensureMainAgent(sessionId: string): Promise<void> {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    const agents = session!.accessor.get(IAgentLifecycleService);
    if (agents.get('main') === undefined) await agents.create({ agentId: 'main' });
  }

  function emit(sessionId: string, event: Event2<any>): void {
    const session = getLiveSessionById(server!.core.accessor, sessionId);
    const main = session!.accessor.get(IAgentLifecycleService).get('main');
    main!.accessor.get(IEventBus).publish(event);
  }

  async function snapshot(sid: string) {
    const res = await fetch(`${base}/api/v1/sessions/${sid}/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number; data: unknown };
    expect(body.code).toBe(0);
    return sessionSnapshotResponseSchema.parse(body.data);
  }

  it('returns a well-formed snapshot for a fresh session', async () => {
    const sid = await createSession();
    const snap = await snapshot(sid);

    expect(snap.session.id).toBe(sid);
    expect(snap.as_of_seq).toBe(1);
    expect(snap.epoch).toMatch(/^ep_/);
    expect(snap.messages.items).toEqual([]);
    expect(snap.in_flight_turn).toBeNull();
    expect(snap.pending_approvals).toEqual([]);
    expect(snap.pending_questions).toEqual([]);
  });

  it('reflects the durable watermark and in-flight turn after events', async () => {
    const sid = await createSession();
    await ensureMainAgent(sid);
    await snapshot(sid);

    emit(sid, {
      type: 'turn.started',
      turnId: 1,
    } as unknown as Event2<any>);
    emit(sid, { type: 'assistant.delta', turnId: 1, delta: 'Hello' } as unknown as Event2<any>);

    const snap = await snapshot(sid);
    expect(snap.as_of_seq).toBeGreaterThanOrEqual(2);
    expect(snap.in_flight_turn).toMatchObject({
      turn_id: 1,
      assistant_text: 'Hello',
    });
  });

  it('returns 404 for an unknown session', async () => {
    const res = await fetch(`${base}/api/v1/sessions/sess_does_not_exist/snapshot`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as { code: number };
    expect(body.code).not.toBe(0);
  });

  it('loads a cold (not live) session instead of 404', async () => {
    const sid = await createSession();

    await server!.close();
    server = undefined;
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    expect(getLiveSessionById(server!.core.accessor, sid)).toBeUndefined();

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
  });

  it('returns the persisted transcript for a cold session', async () => {
    const sid = await createSession();
    const live = getLiveSessionById(server!.core.accessor, sid);
    if (live === undefined) throw new Error(`session ${sid} not found`);
    const metaScope = live.accessor.get(ISessionContext).metaScope;

    const wireDir = join(home as string, metaScope, 'agents', 'main');
    await mkdir(wireDir, { recursive: true });
    const records = [
      { type: 'metadata', protocol_version: '1.4', created_at: Date.now() },
      {
        type: 'context.append_message',
        message: { role: 'user', content: [{ type: 'text', text: 'hello-from-disk' }], toolCalls: [] },
      },
      {
        type: 'context.append_message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi-from-disk' }],
          toolCalls: [],
        },
      },
    ];
    await writeFile(
      join(wireDir, 'wire.jsonl'),
      records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      'utf-8',
    );

    await server!.close();
    server = undefined;
    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    expect(getLiveSessionById(server!.core.accessor, sid)).toBeUndefined();

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
    expect(snap.messages.items).toHaveLength(2);
    expect((snap.messages.items[0]!.content[0] as { text: string }).text).toBe('hello-from-disk');
    expect((snap.messages.items[1]!.content[0] as { text: string }).text).toBe('hi-from-disk');
    expect(snap.epoch).toMatch(/^ep_/);
  });

  it('serves a v1-layout session (ISO timestamps, no id field) without crashing', async () => {
    const sid = await createSession();
    const session = getLiveSessionById(server!.core.accessor, sid);
    if (session === undefined) throw new Error(`session ${sid} not found`);
    const metaScope = session.accessor.get(ISessionContext).metaScope;

    await server!.close();
    server = undefined;
    const statePath = join(home as string, metaScope, 'state.json');
    await writeFile(
      statePath,
      JSON.stringify({
        title: 'v1 session',
        createdAt: '2026-06-01T10:00:00.000Z',
        updatedAt: '2026-06-01T11:00:00.000Z',
        archived: false,
        custom: { source: 'v1' },
      }),
    );

    server = await startServer({ hostIdentity: TEST_HOST_IDENTITY, host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;

    const resumed = await resumeSessionById(server!.core.accessor, sid);
    if (resumed === undefined) throw new Error(`session ${sid} failed to resume`);
    const main = await resumed.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const context = main.accessor.get(IAgentContextMemoryService);
    context.append({ role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] });
    context.append({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], toolCalls: [] });

    const snap = await snapshot(sid);
    expect(snap.session.id).toBe(sid);
    expect(snap.session.title).toBe('v1 session');
    expect(Number.isNaN(Date.parse(snap.session.created_at))).toBe(false);
    expect(snap.messages.items.length).toBeGreaterThan(0);
    for (const message of snap.messages.items) {
      expect(Number.isNaN(Date.parse(message.created_at))).toBe(false);
    }
  });
});
