#!/usr/bin/env node
/**
 * Scenario 03 — "user refreshes the browser" / "user clicks an existing session
 * from the history list" wire-level walkthrough.
 *
 * This is the worst-case page-load sequence a web client runs while the
 * server is already up. The phases (REST.md §3, WS.md §3) are:
 *
 *   Phase 0  environment probes        GET /healthz, /meta, /auth
 *   Phase 1  open WS BEFORE history    server_hello → client_hello(cursors) → ack
 *   Phase 2  pull persisted snapshot   GET /sessions/{sid}, /messages, /tasks
 *   Phase 5  steady state              POST /prompts → observe events on WS
 *
 * Phase ordering matters: if Phase 2 ran before Phase 1, turn events emitted
 * in the gap would have no subscriber on this connection — they'd still land
 * in the ring buffer, but REST `/messages` only reflects flushed-to-store
 * content, so the "in-flight" delta would be invisible to the UI.
 *
 * What this scenario exercises end-to-end against a running server:
 *   - All three Phase 0 endpoints respond and `meta.server_id` is non-empty.
 *   - A first WS session completes one prompt; we record the current ring-buffer
 *     seq for the session.
 *   - We close the WS, open a fresh one, and on `client_hello` pass
 *     `cursors: { [sid]: { seq: currentSeq } }` — the server should ack
 *     with `accepted_subscriptions: [sid]`, `resync_required: []`, and NOT
 *     replay any events (we are caught up).
 *   - We then open a THIRD connection, this time with
 *     `cursors: { [sid]: { seq: 0 } }` — the server should replay every
 *     durable event (seq 1..N) BEFORE the ack lands.
 *   - Phase 2 REST snapshot reflects the user + assistant messages persisted
 *     during the first run.
 *   - Phase 5: a new prompt over the third connection delivers events on WS.
 *
 * Usage:
 *   KIMI_SERVER_URL=http://127.0.0.1:58627 npx tsx scenarios/03-refresh-replay.ts
 *
 * Exit codes:
 *   0  — pass
 *   1  — assertion failure, timeout, or server error
 */
import assert from 'node:assert/strict';

import { DaemonClient, WsClient, type AnyFrame } from '../src/index';
import { fetchWithReport } from '../src/report';
import { WebSocket as WsWebSocket } from 'ws';

const KIMI_SERVER_URL = process.env['KIMI_SERVER_URL'] ?? 'http://127.0.0.1:58627';
const API_PREFIX = '/api/v1';
const HANDSHAKE_TIMEOUT_MS = 5_000;
const PROMPT_TIMEOUT_MS = 60_000;

interface Envelope<T> {
  code: number;
  msg?: string;
  data: T;
}

interface MetaResponse {
  server_id: string;
  server_version: string;
  started_at: string;
}

interface ClientHelloPayload extends Record<string, unknown> {
  client_id: string;
  subscriptions: string[];
  cursors?: Record<string, { seq: number; epoch?: string }>;
}

interface AckPayload {
  accepted_subscriptions?: string[];
  resync_required?: string[];
}

interface OpenSocketResult {
  ws: WsClient;
  serverHello: unknown;
  ack: AnyFrame;
  replayed: AnyFrame[];
  log: AnyFrame[];
}

interface PromptCompletedPayload {
  prompt_id?: string;
  promptId?: string;
}

async function fetchEnvelope<T>(url: string): Promise<T> {
  const res = await fetchWithReport(url, { headers: { accept: 'application/json' } });
  const body = (await res.json()) as Envelope<T>;
  assert.equal(typeof body.code, 'number', `${url}: missing envelope.code`);
  assert.equal(body.code, 0, `${url}: code=${body.code} msg=${body.msg ?? ''}`);
  return body.data;
}

async function openSocketWithHello({
  sid,
  lastSeq,
}: {
  sid: string;
  lastSeq?: number;
}): Promise<OpenSocketResult> {
  const wsUrl = `${KIMI_SERVER_URL.replace(/^http/, 'ws')}${API_PREFIX}/ws`;
  const ws = new WsClient({ url: wsUrl, wsImpl: WsWebSocket, logger: () => {} });
  await ws.open();

  // Capture every frame on its arrival timeline (queue order). Used to
  // distinguish replay events (arrive BEFORE ack) from steady-state events.
  const log: AnyFrame[] = [];
  ws.onFrame((f) => log.push(f));

  // 1) server_hello
  const helloFrame = await ws.waitForFrame((f) => f.type === 'server_hello', HANDSHAKE_TIMEOUT_MS);

  // 2) client_hello
  const helloId = `hello-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload: ClientHelloPayload = {
    client_id: `scenario-03-${process.pid}`,
    subscriptions: [sid],
  };
  if (lastSeq !== undefined) payload.cursors = { [sid]: { seq: lastSeq } };
  ws.send({ type: 'client_hello', id: helloId, payload });

  // 3) wait for the matching ack
  const ack = await ws.waitForFrame(
    (f) => f.type === 'ack' && f.id === helloId,
    HANDSHAKE_TIMEOUT_MS,
  );

  // Replay events arrived before the ack — slice them out of the log by
  // position. (Anything appended to `log` AFTER this point is steady-state.)
  // The server emits agent-core event types without an `event.` prefix
  // (`turn.started`, `assistant.delta`, …), so we filter on the structural
  // shape (has `seq`, has `session_id`, isn't a system frame) instead of a
  // type prefix.
  const replayed = log.filter(
    (f) =>
      f.type !== 'server_hello' &&
      f.type !== 'ack' &&
      f.type !== 'ping' &&
      f.type !== 'resync_required' &&
      f.type !== 'error' &&
      typeof f.seq === 'number' &&
      f.session_id === sid &&
      (lastSeq === undefined || f.seq > lastSeq),
  );

  return { ws, serverHello: helloFrame.payload, ack, replayed, log };
}

async function main() {
  console.log(`▶ server at ${KIMI_SERVER_URL}`);

  // ── Phase 0 ─────────────────────────────────────────────────────────────
  const health = await fetchEnvelope<{ ok: boolean }>(`${KIMI_SERVER_URL}${API_PREFIX}/healthz`);
  assert.equal(health.ok, true, 'healthz did not return ok=true');

  const meta = await fetchEnvelope<MetaResponse>(`${KIMI_SERVER_URL}${API_PREFIX}/meta`);
  assert.ok(typeof meta.server_id === 'string' && meta.server_id.length > 0, 'missing server_id');
  assert.ok(typeof meta.started_at === 'string', 'missing started_at');
  assert.ok(typeof meta.server_version === 'string', 'missing server_version');
  const firstServerId = meta.server_id;
  console.log(`▶ phase 0: server_id=${firstServerId} version=${meta.server_version}`);

  const auth = await fetchEnvelope<{ ready: boolean; providers_count: number }>(
    `${KIMI_SERVER_URL}${API_PREFIX}/auth`,
  );
  assert.equal(typeof auth.ready, 'boolean', 'auth.ready missing');
  assert.equal(typeof auth.providers_count, 'number', 'auth.providers_count missing');
  console.log(`▶ phase 0: auth.ready=${auth.ready}`);

  // ── Initial flow: create + drive a prompt to populate the ring buffer ───
  const initial = new DaemonClient({ baseUrl: KIMI_SERVER_URL });
  let sid: string | undefined;
  try {
    const session = await initial.createSession({ metadata: { cwd: process.cwd() } });
    sid = session.id;
    console.log(`▶ session ${sid} created`);

    await initial.connect();
    await initial.subscribe(sid);

    // Track every event we see on this connection so we know the max seq.
    let maxSeq = 0;
    initial.onFrame((f) => {
      if (typeof f.seq === 'number' && f.session_id === sid && f.seq > maxSeq) {
        maxSeq = f.seq;
      }
    });

    const { prompt_id, finalFrame } = await initial.submitAndWait(
      sid,
      {
        content: [{ type: 'text', text: 'Reply with the single word "REFRESH" and nothing else.' }],
      },
      { waitFor: 'prompt.completed', timeoutMs: PROMPT_TIMEOUT_MS },
    );
    if (typeof finalFrame.seq === 'number' && finalFrame.seq > maxSeq) maxSeq = finalFrame.seq;
    assert.ok(maxSeq > 0, `expected at least one event before reconnect, maxSeq=${maxSeq}`);
    console.log(`▶ prompt ${prompt_id} completed; maxSeq=${maxSeq}`);

    await initial.close();

    // ── Phase 0 again — simulate a browser refresh (cheap re-probe) ──────
    const meta2 = await fetchEnvelope<MetaResponse>(`${KIMI_SERVER_URL}${API_PREFIX}/meta`);
    assert.equal(meta2.server_id, firstServerId, 'server_id changed mid-scenario — server restarted?');

    // ── Phase 1 (refresh #1): caught-up reconnect — no replay expected ───
    const caughtUp = await openSocketWithHello({ sid, lastSeq: maxSeq });
    assert.equal(caughtUp.ack.code, 0, `caught-up client_hello rejected: ${caughtUp.ack.msg}`);
    const ackPayloadA = (caughtUp.ack.payload ?? {}) as AckPayload;
    assert.deepEqual(
      ackPayloadA.accepted_subscriptions ?? [],
      [sid],
      'expected accepted_subscriptions=[sid] for caught-up reconnect',
    );
    assert.deepEqual(
      ackPayloadA.resync_required ?? [],
      [],
      'expected resync_required=[] for caught-up reconnect',
    );
    assert.equal(
      caughtUp.replayed.length,
      0,
      `expected 0 replay events when caught up, got ${caughtUp.replayed.length}`,
    );
    console.log(`▶ refresh #1: caught-up; accepted=[${sid}], replayed=0`);
    await caughtUp.ws.close();

    // ── Phase 1 (refresh #2): seq=0 — server replays the whole buffer ────
    const replay = await openSocketWithHello({ sid, lastSeq: 0 });
    assert.equal(replay.ack.code, 0, `replay client_hello rejected: ${replay.ack.msg}`);
    const ackPayloadB = (replay.ack.payload ?? {}) as AckPayload;
    assert.deepEqual(
      ackPayloadB.accepted_subscriptions ?? [],
      [sid],
      'expected accepted_subscriptions=[sid] for replay reconnect',
    );
    assert.deepEqual(
      ackPayloadB.resync_required ?? [],
      [],
      'expected resync_required=[] when buffer covers seq=1..maxSeq',
    );
    assert.ok(
      replay.replayed.length > 0,
      `expected server to replay buffered events on last_seq=0, got 0`,
    );
    const seqs = replay.replayed
      .map((f) => f.seq)
      .filter((n): n is number => typeof n === 'number');
    assert.equal(
      Math.min(...seqs),
      1,
      `expected replay to start at seq=1, got ${Math.min(...seqs)}`,
    );
    assert.equal(
      Math.max(...seqs),
      maxSeq,
      `expected replay to end at seq=maxSeq (${maxSeq}), got ${Math.max(...seqs)}`,
    );
    console.log(`▶ refresh #2: replay seq=1..${maxSeq} (${replay.replayed.length} events)`);

    // ── Phase 2: persisted REST snapshot reflects the first prompt ───────
    const fetched = await initial.http.getSession(sid);
    assert.equal(fetched.id, sid, 'getSession returned wrong session id');

    const { items: messages } = await initial.http.listMessages(sid, { page_size: 100 });
    assert.ok(
      messages.some((m) => m.role === 'user'),
      'expected at least one user message in /messages snapshot',
    );
    assert.ok(
      messages.some((m) => m.role === 'assistant'),
      'expected at least one assistant message in /messages snapshot',
    );

    // No `listTasks` helper on HttpClient — call the endpoint directly to
    // verify it responds with the documented `{items: []}` envelope.
    const tasks = await fetchEnvelope<{ items: unknown[] }>(
      `${KIMI_SERVER_URL}${API_PREFIX}/sessions/${encodeURIComponent(sid)}/tasks`,
    );
    assert.ok(Array.isArray(tasks.items), 'GET /tasks must return items[]');
    console.log(`▶ phase 2: messages=${messages.length} tasks=${tasks.items.length}`);

    // ── Phase 5: steady state — issue a new prompt over the live socket ──
    // The third socket (`replay.ws`) is still open and subscribed; we drive
    // a follow-up prompt via REST and assert events arrive on this WS.
    const followUp = await initial.submitPrompt(sid, {
      content: [{ type: 'text', text: 'Reply with the single word "DONE" and nothing else.' }],
    });
    const completed = await replay.ws.waitForFrame(
      (f) => {
        if (f.type !== 'prompt.completed') return false;
        const p = (f.payload ?? {}) as PromptCompletedPayload;
        const pid = p.prompt_id ?? p.promptId;
        return pid === followUp.prompt_id;
      },
      PROMPT_TIMEOUT_MS,
    );
    assert.ok(typeof completed.seq === 'number' && completed.seq > maxSeq, 'follow-up seq did not advance');
    console.log(`▶ phase 5: follow-up prompt completed at seq=${completed.seq}`);

    await replay.ws.close();

    console.log('✓ 03-refresh-replay: refresh round-trip preserves subscription + replay semantics');
  } finally {
    try {
      if (sid) await initial.http.archiveSession(sid);
    } catch {
      // ignore
    }
    try {
      await initial.close();
    } catch {
      // ignore
    }
  }
}

main().catch((err) => {
  console.error('✗ 03-refresh-replay failed:', err);
  process.exit(1);
});
