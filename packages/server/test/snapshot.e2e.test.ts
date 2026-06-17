/**
 * `GET /api/v1/sessions/{sid}/snapshot` end-to-end tests (v2 sync protocol).
 *
 * Bootstrap mirrors `messages.e2e.test.ts`: real server (port 0, tmp lock +
 * bridge home), endpoints exercised via `app.inject(...)`.
 *
 * Coverage:
 *   - Fresh idle session → as_of_seq=0, ep_* epoch, empty messages, null
 *     in_flight_turn, empty pending lists.
 *   - Durable events published → as_of_seq advances and matches the WS
 *     broadcast cursor (the snapshot↔stream alignment invariant).
 *   - Mid-turn snapshot → in_flight_turn carries accumulated assistant text
 *     and running tools; turn.ended clears it.
 *   - Unknown session id → 40401.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Event, SessionSnapshotResponse } from '@moonshot-ai/protocol';
import { IEventService, IPromptService, PromptService } from '@moonshot-ai/agent-core';

import { IRestGateway, IWSBroadcastService, startServer, type RunningServer } from '../src';
import { WSBroadcastService } from '#/services/gateway/wsBroadcastService';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-snapshot-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-snapshot-home-'));
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  return server;
}

function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
} {
  return body as { code: number; msg: string; data: T | null; request_id: string };
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`failed to create session: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

async function getSnapshot(
  r: RunningServer,
  sid: string,
): Promise<{ statusCode: number; env: ReturnType<typeof envelopeOf<SessionSnapshotResponse>> }> {
  const res = await appOf(r).inject({
    method: 'GET',
    url: `/api/v1/sessions/${sid}/snapshot`,
  });
  return { statusCode: res.statusCode, env: envelopeOf<SessionSnapshotResponse>(res.json()) };
}

describe('GET /api/v1/sessions/{sid}/snapshot (v2 initial sync)', () => {
  it('idle fresh session → empty snapshot at the session-creation watermark', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);

    const { statusCode, env } = await getSnapshot(r, sid);
    expect(statusCode).toBe(200);
    expect(env.code).toBe(0);
    const data = env.data!;
    expect(data.epoch).toMatch(/^ep_/);
    expect(data.session.id).toBe(sid);
    expect(data.messages.items).toEqual([]);
    expect(data.messages.has_more).toBe(false);
    expect(data.in_flight_turn).toBeNull();
    expect(data.pending_approvals).toEqual([]);
    expect(data.pending_questions).toEqual([]);
  });

  it('as_of_seq matches the WS broadcast cursor after durable events', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const bus = r.services.invokeFunction((a) => a.get(IEventService));
    const broadcast = r.services.invokeFunction(
      (a) => a.get(IWSBroadcastService),
    ) as WSBroadcastService;

    const baseline = (await broadcast.getCursor(sid)).seq;
    bus.publish({ type: 'evt.x', sessionId: sid, agentId: 'main' } as unknown as Event);
    bus.publish({ type: 'evt.y', sessionId: sid, agentId: 'main' } as unknown as Event);

    const { env } = await getSnapshot(r, sid);
    const cursor = await broadcast.getCursor(sid);
    expect(env.data!.as_of_seq).toBe(baseline + 2);
    expect(env.data!.as_of_seq).toBe(cursor.seq);
    expect(env.data!.epoch).toBe(cursor.epoch);
  });

  it('mid-turn snapshot carries accumulated text + running tools; turn.ended clears it', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const bus = r.services.invokeFunction((a) => a.get(IEventService));

    bus.publish({
      type: 'turn.started',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      origin: { kind: 'user' },
    } as unknown as Event);
    bus.publish({
      type: 'assistant.delta',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      delta: 'partial ans',
    } as unknown as Event);
    bus.publish({
      type: 'tool.call.started',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      toolCallId: 'call_1',
      name: 'Bash',
      args: { command: 'ls' },
    } as unknown as Event);
    bus.publish({
      type: 'tool.progress',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      toolCallId: 'call_1',
      update: { kind: 'stdout', text: 'src\n' },
    } as unknown as Event);

    const { env } = await getSnapshot(r, sid);
    const turn = env.data!.in_flight_turn;
    expect(turn).not.toBeNull();
    expect(turn!.turn_id).toBe(1);
    expect(turn!.assistant_text).toBe('partial ans');
    expect(turn!.running_tools).toHaveLength(1);
    expect(turn!.running_tools[0]!.tool_call_id).toBe('call_1');
    expect(turn!.running_tools[0]!.last_progress?.text).toBe('src\n');

    bus.publish({
      type: 'tool.result',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      toolCallId: 'call_1',
      output: 'src',
    } as unknown as Event);
    bus.publish({
      type: 'turn.ended',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      reason: 'completed',
    } as unknown as Event);

    const after = await getSnapshot(r, sid);
    expect(after.env.data!.in_flight_turn).toBeNull();
  });

  it('in_flight_turn carries current_prompt_id from the active prompt', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const bus = r.services.invokeFunction((a) => a.get(IEventService));

    bus.publish({
      type: 'turn.started',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      origin: { kind: 'user' },
    } as unknown as Event);
    bus.publish({
      type: 'assistant.delta',
      sessionId: sid,
      agentId: 'main',
      turnId: 1,
      delta: 'partial',
    } as unknown as Event);

    // Inject an active prompt record so the snapshot route can read its id.
    const promptId = `prompt_SNAPSHOT_TEST_${sid}`;
    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptService,
    );
    impl._injectActiveForTest(sid, promptId, 1);

    const { env } = await getSnapshot(r, sid);
    const turn = env.data!.in_flight_turn;
    expect(turn).not.toBeNull();
    expect(turn!.current_prompt_id).toBe(promptId);
  });

  it('returns 40401 for an unknown session id', async () => {
    const r = await bootDaemon();
    const { env } = await getSnapshot(r, 'sess_missing');
    expect(env.code).toBe(40401);
    expect(env.data).toBeNull();
  });
});
