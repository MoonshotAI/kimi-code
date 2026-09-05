import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  IAgentLifecycleService,
  IEventBus,
  ISessionIndex,
  getLiveSessionById,
  IModelCatalog,
  type ScopeSeed,
} from '@moonshot-ai/agent-core-v2';
import { TurnStarted, TurnStepStarted } from '@moonshot-ai/agent-core-v2/agent/loop/turnEvents';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: { path: string; message: string }[];
}

interface HistoryWire {
  messages: Record<string, unknown>[];
  has_more: boolean;
  in_flight?: { turn_id: string; step_id: string };
}

const T0 = 1_700_000_000_000;

function rec(type: string, fields: Record<string, unknown>, time: number): string {
  return JSON.stringify({ type, time, ...fields });
}

function loopEvent(event: Record<string, unknown>, time: number): string {
  return rec('context.append_loop_event', { event }, time);
}

const MAIN_WIRE = [
  rec('turn.prompt', {
    input: [{ type: 'text', text: 'hello world' }],
    origin: { kind: 'user' },
    promptId: 'p0',
  }, T0),
  rec('context.append_message', {
    message: {
      id: 'p0',
      role: 'user',
      content: [{ type: 'text', text: 'hello world' }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  }, T0 + 1),
  loopEvent({ type: 'step.begin', uuid: 'u1', turnId: '0', step: 1 }, T0 + 2),
  loopEvent({ type: 'content.part', stepUuid: 'u1', part: { type: 'text', text: 'Hi there' } }, T0 + 3),
  loopEvent({ type: 'tool.call', stepUuid: 'u1', toolCallId: 'call_1', name: 'Bash', args: '{"command":"ls"}' }, T0 + 4),
  loopEvent({ type: 'tool.result', toolCallId: 'call_1', result: { output: 'file.txt' } }, T0 + 5),
  loopEvent({ type: 'step.end', uuid: 'u1', finishReason: 'stop' }, T0 + 6),
  rec('turn.ended', { turnId: 0, reason: 'completed', durationMs: 700 }, T0 + 7),
  rec(
    'task.started',
    {
      info: {
        taskId: 'task-2',
        kind: 'agent',
        agentId: 'sub-1',
        parentToolCallId: 'call_1',
        status: 'running',
      },
    },
    T0 + 8,
  ),
  rec('turn.prompt', {
    input: [{ type: 'text', text: 'second question' }],
    origin: { kind: 'user' },
    promptId: 'p1',
  }, T0 + 9),
  rec('context.append_message', {
    message: {
      id: 'p1',
      role: 'user',
      content: [{ type: 'text', text: 'second question' }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
  }, T0 + 10),
  loopEvent({ type: 'step.begin', uuid: 'u2', turnId: '1', step: 1 }, T0 + 11),
  loopEvent({ type: 'content.part', stepUuid: 'u2', part: { type: 'text', text: 'second answer' } }, T0 + 12),
  loopEvent({ type: 'step.end', uuid: 'u2' }, T0 + 13),
  rec('turn.ended', { turnId: 1, reason: 'completed' }, T0 + 14),
];

const SUB_WIRE = [
  rec('turn.prompt', {
    input: [{ type: 'text', text: 'do sub work' }],
    origin: { kind: 'system_trigger', name: 'subagent' },
  }, T0 + 20),
  loopEvent({ type: 'step.begin', uuid: 's1', turnId: '0', step: 1 }, T0 + 21),
  loopEvent({ type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'sub answer' } }, T0 + 22),
  loopEvent({ type: 'step.end', uuid: 's1' }, T0 + 23),
  rec('turn.ended', { turnId: 0, reason: 'completed' }, T0 + 24),
];

describe('server /api/v1/sessions/{sid}/history', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let seeds: ScopeSeed | undefined;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-history-'));
    const modelCatalog: IModelCatalog = {
      _serviceBrand: undefined,
      get: () => {
        throw new Error('modelCatalog.get not exercised in this test');
      },
      getRequester: () => {
        throw new Error('modelCatalog.getRequester not exercised in this test');
      },
      inspect: () => {
        throw new Error('modelCatalog.inspect not exercised in this test');
      },
      ping: () => {
        throw new Error('modelCatalog.ping not exercised in this test');
      },
      findByName: () => [],
      listModels: async () => [],
      listProviders: async () => [],
      getProvider: async () => {
        throw new Error('modelCatalog.getProvider not exercised in this test');
      },
      setDefaultModel: async () => {
        throw new Error('modelCatalog.setDefaultModel not exercised in this test');
      },
    };
    seeds = [[IModelCatalog, modelCatalog]];
    await boot();
  });

  async function boot(): Promise<void> {
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home as string,
      logLevel: 'silent',
      seeds,
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function createSession(): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd: home as string } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function workspaceIdOf(sessionId: string): Promise<string> {
    const summary = await server!.core.accessor.get(ISessionIndex).get(sessionId);
    if (summary === undefined) throw new Error(`session ${sessionId} not found in index`);
    return summary.workspaceId;
  }

  async function writeWire(sessionId: string, agentId: string, lines: readonly string[]): Promise<void> {
    const workspaceId = await workspaceIdOf(sessionId);
    const path = join(home as string, 'sessions', workspaceId, sessionId, 'agents', agentId, 'wire.jsonl');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${lines.join('\n')}\n`, 'utf8');
  }

  async function reboot(): Promise<void> {
    await server!.close();
    server = undefined;
    await boot();
  }

  const entityId = (m: Record<string, unknown>): unknown => {
    switch (m['type']) {
      case 'turn':
        return m['turn_id'];
      case 'step':
        return m['step_id'];
      case 'user':
      case 'assistant':
      case 'thinking':
        return m['message_id'];
      case 'tool_call':
        return m['tool_call_id'];
      case 'system':
        return m['system_id'];
      case 'interaction':
        return m['interaction_id'];
      case 'task':
        return m['task_id'];
      default:
        return m['type'];
    }
  };

  it('returns 40401 for an unknown session', async () => {
    const { body } = await getJson<null>('/api/v1/sessions/nope/history');
    expect(body.code).toBe(40401);
  });

  it('returns an empty page without in_flight for a live session with no agent history', async () => {
    const id = await createSession();
    const { body } = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history`);
    expect(body.code).toBe(0);
    expect(body.data.messages).toEqual([]);
    expect(body.data.in_flight).toBeUndefined();
  });

  it('rejects mutually exclusive cursors and invalid agent ids and page sizes', async () => {
    const id = await createSession();
    const both = await getJson<null>(`/api/v1/sessions/${id}/history?before_turn=t1&after_step=t0.1`);
    expect(both.body.code).toBe(40001);
    const badAgent = await getJson<null>(`/api/v1/sessions/${id}/history?agent_id=..%2Fevil`);
    expect(badAgent.body.code).toBe(40001);
    const badSize = await getJson<null>(`/api/v1/sessions/${id}/history?page_size=0`);
    expect(badSize.body.code).toBe(40001);
  });

  it('cold-rebuilds the main agent timeline from wire records with pagination cursors', async () => {
    const id = await createSession();
    await writeWire(id, 'main', MAIN_WIRE);
    await writeWire(id, 'sub-1', SUB_WIRE);
    await reboot();

    const all = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history`);
    expect(all.body.code).toBe(0);
    expect(all.body.data.in_flight).toBeUndefined();
    expect(all.body.data.has_more).toBe(false);
    const ids = all.body.data.messages.map(entityId);
    expect(ids).toEqual([
      't0',
      't0.u0',
      't0.1',
      't0.1.a1',
      'call_1',
      'task-2',
      't1',
      't1.u0',
      't1.1',
      't1.1.a1',
    ]);
    const turn0 = all.body.data.messages[0]!;
    expect(turn0).toMatchObject({
      type: 'turn',
      turn_id: 't0',
      state: 'completed',
      origin: { kind: 'user' },
      user_message_id: 't0.u0',
      duration_ms: 700,
    });
    const assistant = all.body.data.messages.find((m) => m['message_id'] === 't0.1.a1')!;
    expect(assistant).toMatchObject({ type: 'assistant', status: 'completed', text: 'Hi there' });
    const tool = all.body.data.messages.find((m) => m['tool_call_id'] === 'call_1')!;
    expect(tool).toMatchObject({ type: 'tool_call', state: 'done', output: 'file.txt', task_id: 'task-2' });
    const task = all.body.data.messages.find((m) => m['type'] === 'task')!;
    expect(task).toMatchObject({ type: 'task', kind: 'subagent', child_agent_id: 'sub-1' });

    const page = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history?page_size=3`);
    expect(page.body.data.messages.map(entityId)).toEqual(['t1.u0', 't1.1', 't1.1.a1']);
    expect(page.body.data.has_more).toBe(true);

    const older = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history?before_turn=t1`);
    expect(older.body.data.messages.map(entityId)).toEqual([
      't0',
      't0.u0',
      't0.1',
      't0.1.a1',
      'call_1',
      'task-2',
    ]);
    expect(older.body.data.has_more).toBe(false);

    const newer = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history?after_step=t0.1`);
    expect(newer.body.data.messages.map(entityId)).toEqual(['task-2', 't1', 't1.u0', 't1.1', 't1.1.a1']);
    expect(newer.body.data.has_more).toBe(false);

    const missing = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history?before_turn=t99`);
    expect(missing.body.data.messages).toEqual([]);
    expect(missing.body.data.has_more).toBe(false);
  });

  it('reads a subagent timeline with agent_id and classifies its turn origin from the main wire', async () => {
    const id = await createSession();
    await writeWire(id, 'main', MAIN_WIRE);
    await writeWire(id, 'sub-1', SUB_WIRE);
    await reboot();

    const main = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history?agent_id=main`);
    const sub = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history?agent_id=sub-1`);
    expect(sub.body.code).toBe(0);
    const ids = sub.body.data.messages.map(entityId);
    expect(ids).toEqual(['t0', 't0.u0', 't0.1', 't0.1.a1']);
    const turn = sub.body.data.messages[0]!;
    expect(turn).toMatchObject({
      type: 'turn',
      turn_id: 't0',
      agent_id: 'sub-1',
      origin: { kind: 'task', task_id: 'task-2' },
    });
    const user = sub.body.data.messages.find((m) => m['type'] === 'user')!;
    expect(user).toMatchObject({ message_id: 't0.u0', text: 'do sub work', agent_id: 'sub-1' });
    expect(main.body.data.messages.map(entityId)).toContain('t1');
  });

  it('marks the in-flight position for a live session once a turn is streaming', async () => {
    const id = await createSession();
    const session = getLiveSessionById(server!.core.accessor, id);
    if (session === undefined) throw new Error(`session ${id} not live`);
    await session.accessor.get(IAgentLifecycleService).create({ agentId: 'main' });
    const agent = session.accessor.get(IAgentLifecycleService).handleOf('main')!;

    const idle = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history`);
    expect(idle.body.data.in_flight).toBeUndefined();

    const bus = agent.accessor.get(IEventBus);
    bus.publish(new TurnStarted({ agentId: 'main', turnId: 0, origin: { kind: 'user' }, prompt: 'hi' }));
    bus.publish(new TurnStepStarted({ agentId: 'main', turnId: 0, step: 1 }));

    const streaming = await getJson<HistoryWire>(`/api/v1/sessions/${id}/history`);
    expect(streaming.body.code).toBe(0);
    expect(streaming.body.data.in_flight).toEqual({ turn_id: 't0', step_id: 't0.1' });
  });
});
