/**
 * Refresh / reload wire-level invariants.
 *
 * Models the page-refresh path a web client takes when the daemon is already
 * up: hit `/healthz`, `/meta`, `/auth`, then open a fresh WebSocket and replay
 * any missed events via `client_hello.last_seq_by_session` BEFORE pulling REST
 * history (REST.md §3 + WS.md §3.2).
 *
 * What's asserted here (and NOT in `client.test.ts`):
 *   1. `/healthz` returns `{ok: true}`.
 *   2. `/meta` exposes a non-empty `daemon_id` — the signal clients use to
 *      detect a daemon restart and flush their `last_seq_by_session` cache.
 *   3. `/auth` returns the `AuthSummary` shape.
 *   4. After running one prompt to populate the ring buffer, a fresh WS that
 *      passes `last_seq_by_session: { [sid]: currentSeq }` is acked with
 *      `accepted_subscriptions: [sid]`, `resync_required: []`, and NO event
 *      frames arrive between `server_hello` and the ack (caught-up replay).
 *   5. A fresh WS that passes `last_seq_by_session: { [sid]: 0 }` triggers
 *      replay of every buffered event in order (seq 1..N) BEFORE the ack.
 *   6. After reconnect, `GET /messages` reflects the persisted state from
 *      before the WS close.
 *
 * Live-daemon gated via the same `daemonReachable()` check as
 * `client.test.ts`; missing daemon → tests skip cleanly so CI stays green.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsWebSocket } from 'ws';

import { DaemonClient, WsClient, type AnyFrame } from '../src/index.js';
import { fetchWithReport } from '../src/report.js';
import { createCaseLogger } from './log.js';

const BASE_URL = process.env['DAEMON_URL'] ?? 'http://127.0.0.1:7878';
const API_PREFIX = '/api/v1';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 120_000;

async function daemonReachable(): Promise<boolean> {
  try {
    const res = await fetchWithReport(`${BASE_URL}${API_PREFIX}/meta`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T;
  request_id?: string;
}

async function getEnvelope<T>(
  path: string,
  log?: (label: string, value?: unknown) => void,
): Promise<T> {
  const res = await fetchWithReport(`${BASE_URL}${API_PREFIX}${path}`, {
    headers: { accept: 'application/json' },
  });
  const body = (await res.json()) as Envelope<T>;
  log?.('http envelope', {
    method: 'GET',
    path: `${API_PREFIX}${path}`,
    status: res.status,
    body,
  });
  expect(typeof body.code, `${path} missing envelope.code`).toBe('number');
  expect(body.code, `${path} returned code=${body.code} msg=${body.msg ?? ''}`).toBe(0);
  return body.data;
}

interface HelloResult {
  ws: WsClient;
  ack: AnyFrame;
  replayed: AnyFrame[];
}

async function openSocketWithHello(opts: {
  sid: string;
  lastSeq?: number;
  clientId?: string;
  log?: (label: string, value?: unknown) => void;
}): Promise<HelloResult> {
  const wsUrl = `${BASE_URL.replace(/^http/, 'ws')}${API_PREFIX}/ws`;
  const ws = new WsClient({ url: wsUrl, wsImpl: WsWebSocket, logger: () => {} });
  opts.log?.('refresh ws open', { url: wsUrl, sid: opts.sid, last_seq: opts.lastSeq });
  await ws.open();

  const arrivals: AnyFrame[] = [];
  ws.onFrame((f) => arrivals.push(f));

  const serverHello = await ws.waitForFrame((f) => f.type === 'server_hello', HANDSHAKE_TIMEOUT_MS);
  opts.log?.('refresh ws server_hello', frameForLog(serverHello));

  const helloId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: Record<string, unknown> = {
    client_id: opts.clientId ?? `vitest-refresh-${process.pid}`,
    subscriptions: [opts.sid],
  };
  if (opts.lastSeq !== undefined) {
    payload['last_seq_by_session'] = { [opts.sid]: opts.lastSeq };
  }
  opts.log?.('refresh ws client_hello', { id: helloId, payload });
  ws.send({ type: 'client_hello', id: helloId, payload });

  const ack = await ws.waitForFrame(
    (f) => f.type === 'ack' && f.id === helloId,
    HANDSHAKE_TIMEOUT_MS,
  );
  opts.log?.('refresh ws ack', frameForLog(ack));

  const replayed = arrivals.filter(
    (f) =>
      f.type !== 'server_hello' &&
      f.type !== 'ack' &&
      f.type !== 'ping' &&
      f.type !== 'resync_required' &&
      f.type !== 'error' &&
      typeof f.seq === 'number' &&
      f.session_id === opts.sid &&
      (opts.lastSeq === undefined || f.seq > opts.lastSeq),
  );
  opts.log?.('refresh ws replayed', {
    count: replayed.length,
    frames: replayed.map(frameForLog),
  });

  return { ws, ack, replayed };
}

const reachable = await daemonReachable();
const describeLive = reachable ? describe : describe.skip;

const created: Array<{ client: DaemonClient; sid: string }> = [];
const sockets: WsClient[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    try {
      await ws.close();
    } catch {
      // ignore
    }
  }
  for (const { client, sid } of created.splice(0)) {
    try {
      await client.http.deleteSession(sid);
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
  }
});

describeLive('refresh-replay (live daemon required)', () => {
  it('phase 0: /healthz returns ok:true', async () => {
    const log = createCaseLogger('refresh: healthz');
    const health = await getEnvelope<{ ok: boolean }>('/healthz', log);
    log('data', health);
    expect(health.ok).toBe(true);
  });

  it('phase 0: /meta exposes daemon_id, version, started_at', async () => {
    const log = createCaseLogger('refresh: meta');
    const meta = await getEnvelope<{
      daemon_id: string;
      daemon_version: string;
      started_at: string;
      capabilities: Record<string, boolean>;
    }>('/meta', log);
    log('data', meta);
    expect(meta.daemon_id).toMatch(/.+/);
    expect(meta.daemon_version).toMatch(/.+/);
    expect(meta.started_at).toMatch(/.+/);
    expect(meta.capabilities['websocket']).toBe(true);
  });

  it('phase 0: /auth returns AuthSummary shape', async () => {
    const log = createCaseLogger('refresh: auth');
    const auth = await getEnvelope<{
      ready: boolean;
      providers_count: number;
      default_model: string | null;
      managed_provider: { name: string; status: string } | null;
    }>('/auth', log);
    log('data', auth);
    expect(typeof auth.ready).toBe('boolean');
    expect(typeof auth.providers_count).toBe('number');
  });

  it(
    'reconnect with caught-up last_seq → ack accepts subscription, no replay events',
    async () => {
      const log = createCaseLogger('refresh: caught-up replay');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('initial subscribe accepted', { session_id: session.id });

      let maxSeq = 0;
      client.onFrame((f) => {
        if (
          typeof f.seq === 'number' &&
          f.session_id === session.id &&
          f.seq > maxSeq
        ) {
          maxSeq = f.seq;
        }
      });

      const { finalFrame } = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Reply with the single word "OK" and nothing else.' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      log('prompt completed frame', frameForLog(finalFrame));
      if (typeof finalFrame.seq === 'number' && finalFrame.seq > maxSeq) {
        maxSeq = finalFrame.seq;
      }
      log('max seq before reconnect', { session_id: session.id, max_seq: maxSeq });
      expect(maxSeq, 'session must publish at least one event before reconnect').toBeGreaterThan(0);

      await client.close();
      log('closed initial socket');

      const refreshed = await openSocketWithHello({ sid: session.id, lastSeq: maxSeq, log });
      sockets.push(refreshed.ws);

      expect(refreshed.ack.code).toBe(0);
      const payload = (refreshed.ack.payload ?? {}) as {
        accepted_subscriptions?: string[];
        resync_required?: string[];
      };
      expect(payload.accepted_subscriptions ?? []).toEqual([session.id]);
      expect(payload.resync_required ?? []).toEqual([]);
      expect(
        refreshed.replayed,
        `expected 0 replay events when caught up, got: ${JSON.stringify(refreshed.replayed.map((f) => `${f.type}@${f.seq}`))}`,
      ).toHaveLength(0);
      log('asserted caught-up replay result', {
        accepted_subscriptions: payload.accepted_subscriptions ?? [],
        resync_required: payload.resync_required ?? [],
        replayed_count: refreshed.replayed.length,
      });
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );

  it(
    'reconnect with last_seq=0 → daemon replays buffered events in order before ack',
    async () => {
      const log = createCaseLogger('refresh: replay from zero');
      const client = new DaemonClient({ baseUrl: BASE_URL });
      const session = await client.createSession({ metadata: { cwd: process.cwd() } });
      created.push({ client, sid: session.id });
      log('created session', session);

      await client.connect();
      await client.subscribe(session.id);
      log('initial subscribe accepted', { session_id: session.id });

      let maxSeq = 0;
      client.onFrame((f) => {
        if (
          typeof f.seq === 'number' &&
          f.session_id === session.id &&
          f.seq > maxSeq
        ) {
          maxSeq = f.seq;
        }
      });

      const { finalFrame } = await client.submitAndWait(
        session.id,
        { content: [{ type: 'text', text: 'Reply with the single word "OK" and nothing else.' }] },
        { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
      );
      log('prompt completed frame', frameForLog(finalFrame));
      if (typeof finalFrame.seq === 'number' && finalFrame.seq > maxSeq) {
        maxSeq = finalFrame.seq;
      }
      log('max seq before reconnect', { session_id: session.id, max_seq: maxSeq });
      expect(maxSeq).toBeGreaterThan(0);

      await client.close();
      log('closed initial socket');

      const refreshed = await openSocketWithHello({ sid: session.id, lastSeq: 0, log });
      sockets.push(refreshed.ws);

      expect(refreshed.ack.code).toBe(0);
      const payload = (refreshed.ack.payload ?? {}) as {
        accepted_subscriptions?: string[];
        resync_required?: string[];
      };
      expect(payload.accepted_subscriptions ?? []).toEqual([session.id]);
      // Buffer cap defaults to 1000; a single prompt emits <<1000 events, so
      // every event is still in the ring → no resync_required.
      expect(payload.resync_required ?? []).toEqual([]);
      expect(refreshed.replayed.length).toBeGreaterThan(0);

      const seqs = refreshed.replayed
        .map((f) => f.seq)
        .filter((n): n is number => typeof n === 'number');
      expect(Math.min(...seqs)).toBe(1);
      expect(Math.max(...seqs)).toBe(maxSeq);
      // Daemon must dispatch buffered events in seq order
      // (eventService.getBufferedSince filters the buffer in insertion order).
      const sorted = seqs.toSorted((a, b) => a - b);
      expect(seqs).toEqual(sorted);
      log('replay seq assertion', {
        min_seq: Math.min(...seqs),
        max_seq: Math.max(...seqs),
        expected_max_seq: maxSeq,
        replayed_count: refreshed.replayed.length,
      });

      // Phase 2: REST snapshot reflects the persisted user + assistant pair.
      const { items } = await client.http.listMessages(session.id, { page_size: 100 });
      log('messages snapshot', {
        count: items.length,
        roles: items.map((m) => m.role),
        messages: items,
      });
      expect(items.some((m) => m.role === 'user')).toBe(true);
      expect(items.some((m) => m.role === 'assistant')).toBe(true);

      // `GET /tasks` returns the documented `{items:[]}` envelope shape.
      const tasks = await getEnvelope<{ items: unknown[] }>(
        `/sessions/${encodeURIComponent(session.id)}/tasks`,
        log,
      );
      log('tasks snapshot', tasks);
      expect(Array.isArray(tasks.items)).toBe(true);
    },
    PROMPT_TIMEOUT_MS + 30_000,
  );
});

function frameForLog(frame: AnyFrame): Record<string, unknown> {
  return {
    type: frame.type,
    seq: frame.seq,
    session_id: frame.session_id,
    id: frame.id,
    code: frame.code,
    msg: frame.msg,
    payload: frame.payload,
  };
}
