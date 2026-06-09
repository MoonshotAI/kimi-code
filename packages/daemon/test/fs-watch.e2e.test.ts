/**
 * `event.fs.changed` end-to-end (W12 / Chain 14, P1.14).
 *
 * AC coverage (ROADMAP §Chain 14):
 *   1. subscribe `/src` → create file → receive `event.fs.changed`
 *   2. burst > 500 changes / 200ms → truncated event
 *   3. two clients, two paths → no cross-delivery
 *   4. > 100 paths per connection → `42902 fs.watch_limit_exceeded`
 *
 * Boots `startDaemon` against a tmp workspace, drives WS clients via the
 * real `ws` library (same shape as `ws-broadcast.e2e.test.ts`), and
 * mutates the filesystem to trigger chokidar events.
 *
 * **Timing note** (chokidar + tmpdir): chokidar's `ready` event takes
 * O(50ms) to fire on a tree the size of these tests. We don't wait for
 * it explicitly; instead each test:
 *   - issues `watch_fs_add` (the ack means the WS handler has called
 *     `chokidar.add`),
 *   - sleeps `WATCH_SETTLE_MS` (= 100ms) to let chokidar register the
 *     paths,
 *   - performs the mutation,
 *   - waits for the `event.fs.changed` envelope up to 2000ms.
 *
 * The 200ms debounce window + 100ms settle gives ~300ms per mutation; AC
 * tests usually finish in ≈500ms.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  IRestGateway,
  startDaemon,
  type RunningDaemon,
} from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let workspace: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-fswatch-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-fswatch-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'docs'), { recursive: true });
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{
    statusCode: number;
    json: () => unknown;
  }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{
        statusCode: number;
        json: () => unknown;
      }>;
    };
  });
}

async function createSession(r: RunningDaemon): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: workspace } },
  });
  const env = res.json() as { code: number; data: { id: string } | null };
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

function wsUrl(http: string): string {
  return http.replace(/^http:\/\//, 'ws://') + '/api/v1/ws';
}

interface WsFrame {
  type: string;
  payload?: Record<string, unknown>;
  id?: string;
  code?: number;
  msg?: string;
  seq?: number;
  session_id?: string;
}

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(String(data)) as WsFrame;
      } catch {
        return;
      }
      if (waiters.length > 0) {
        const w = waiters.shift();
        w?.(parsed);
      } else {
        queue.push(parsed);
      }
    });
    ws.once('open', () => resolve({ ws, queue, waiters }));
    ws.once('error', (err) => reject(err));
  });
}

function receive(conn: Conn, timeoutMs: number): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    if (conn.queue.length > 0) {
      resolve(conn.queue.shift()!);
      return;
    }
    const t = setTimeout(() => {
      const idx = conn.waiters.indexOf(waiter);
      if (idx >= 0) conn.waiters.splice(idx, 1);
      reject(new Error(`no message in ${timeoutMs}ms`));
    }, timeoutMs);
    const waiter = (frame: WsFrame): void => {
      clearTimeout(t);
      resolve(frame);
    };
    conn.waiters.push(waiter);
  });
}

async function receiveType(
  conn: Conn,
  type: string,
  timeoutMs: number,
): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`no message of type ${type} within ${timeoutMs}ms`);
    }
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

async function helloAndSubscribe(
  conn: Conn,
  clientId: string,
  sessionId: string,
): Promise<void> {
  await receiveType(conn, 'server_hello', 1000);
  conn.ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: `cli_${clientId}`,
      payload: { client_id: clientId, subscriptions: [sessionId] },
    }),
  );
  await receiveType(conn, 'ack', 1000);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Time we give chokidar to register newly-watched paths before we mutate. */
const WATCH_SETTLE_MS = 150;

describe('WS fs watch (W12 / Chain 14)', () => {
  it('AC #1: subscribe /src → create file → receive event.fs.changed', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r.address));
    await helloAndSubscribe(conn, 'A', sid);

    // Add `src` to watch_fs.
    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w1',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    expect(ack.payload).toMatchObject({ watched_paths: ['src'] });

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'new.ts'), 'export const x = 1;\n');

    const ev = await receiveType(conn, 'event.fs.changed', 2000);
    expect(ev.session_id).toBe(sid);
    const payload = ev.payload as {
      changes: Array<{ path: string; change: string; kind: string }>;
      coalesced_window_ms: number;
      truncated?: boolean;
    };
    expect(payload.coalesced_window_ms).toBe(200);
    expect(payload.truncated).toBeUndefined();
    expect(payload.changes.length).toBeGreaterThanOrEqual(1);
    // Path is POSIX-relative to cwd; should mention `src/new.ts` or the dir
    // (created event lands as soon as the file's parent directory dispatches).
    const paths = payload.changes.map((c) => c.path);
    expect(paths.some((p) => p === 'src/new.ts' || p === 'src')).toBe(true);

    conn.ws.close();
  });

  it('AC #2: burst > 500 changes inside 200ms window → truncated:true', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r.address));
    await helloAndSubscribe(conn, 'A', sid);

    // Watch the whole workspace root so every new file lands in scope.
    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w2',
        payload: { session_id: sid, paths: ['.'] },
      }),
    );
    await receiveType(conn, 'ack', 1000);

    await sleep(WATCH_SETTLE_MS);

    // Slam 600 files into a fresh dir; chokidar emits >500 add events well
    // inside one 200ms window.
    const burstDir = join(workspace, 'burst');
    mkdirSync(burstDir, { recursive: true });
    for (let i = 0; i < 600; i++) {
      writeFileSync(join(burstDir, `f${i}.txt`), `x${i}`);
    }

    // Drain frames until we see truncated:true OR run out of time.
    const deadline = Date.now() + 4000;
    let sawTruncated = false;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      let frame: WsFrame;
      try {
        frame = await receive(conn, remaining);
      } catch {
        break;
      }
      if (frame.type !== 'event.fs.changed') continue;
      const payload = frame.payload as { truncated?: boolean; count?: number };
      if (payload.truncated === true) {
        expect(payload.count).toBeGreaterThan(500);
        sawTruncated = true;
        break;
      }
    }
    expect(sawTruncated).toBe(true);
    conn.ws.close();
  });

  it('AC #3: two clients on disjoint paths receive only their own changes', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const a = await openConn(wsUrl(r.address));
    const b = await openConn(wsUrl(r.address));
    await helloAndSubscribe(a, 'A', sid);
    await helloAndSubscribe(b, 'B', sid);

    a.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wA',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    await receiveType(a, 'ack', 1000);
    b.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wB',
        payload: { session_id: sid, paths: ['docs'] },
      }),
    );
    await receiveType(b, 'ack', 1000);

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
    writeFileSync(join(workspace, 'docs', 'b.md'), 'b');

    // A should see src changes only.
    const evA = await receiveType(a, 'event.fs.changed', 2000);
    const payloadA = evA.payload as {
      changes: Array<{ path: string }>;
    };
    expect(payloadA.changes.some((c) => c.path.startsWith('src/'))).toBe(true);
    expect(payloadA.changes.some((c) => c.path.startsWith('docs/'))).toBe(false);

    // B should see docs changes only.
    const evB = await receiveType(b, 'event.fs.changed', 2000);
    const payloadB = evB.payload as {
      changes: Array<{ path: string }>;
    };
    expect(payloadB.changes.some((c) => c.path.startsWith('docs/'))).toBe(true);
    expect(payloadB.changes.some((c) => c.path.startsWith('src/'))).toBe(false);

    // Cross-contamination check: A should NOT receive any frame whose
    // changes touch docs/, and vice versa. Drain a short window.
    const drainDeadline = Date.now() + 400;
    while (Date.now() < drainDeadline) {
      const remaining = drainDeadline - Date.now();
      try {
        const frame = await receive(a, remaining);
        if (frame.type !== 'event.fs.changed') continue;
        const p = frame.payload as { changes: Array<{ path: string }> };
        expect(p.changes.some((c) => c.path.startsWith('docs/'))).toBe(false);
      } catch {
        break;
      }
    }

    a.ws.close();
    b.ws.close();
  });

  it('AC #4: > 100 paths on one connection → 42902 fs.watch_limit_exceeded', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r.address));
    await helloAndSubscribe(conn, 'A', sid);

    // Create 101 directories so each path resolves under cwd successfully
    // (we don't want a 41304 / 40409 false-positive masking the 42902).
    const paths: string[] = [];
    for (let i = 0; i < 101; i++) {
      const p = `dir${i}`;
      mkdirSync(join(workspace, p), { recursive: true });
      paths.push(p);
    }

    // First add 100 — should succeed.
    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w100',
        payload: { session_id: sid, paths: paths.slice(0, 100) },
      }),
    );
    const ack100 = await receiveType(conn, 'ack', 2000);
    expect(ack100.code).toBe(0);
    const payload100 = ack100.payload as { current_count: number };
    expect(payload100.current_count).toBe(100);

    // 101st path → 42902.
    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w101',
        payload: { session_id: sid, paths: [paths[100]!] },
      }),
    );
    const ack101 = await receiveType(conn, 'ack', 2000);
    expect(ack101.code).toBe(42902);

    conn.ws.close();
  });

  it('idempotent: adding the same path twice keeps watched_paths singular', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r.address));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w1',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    await receiveType(conn, 'ack', 1000);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w2',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    const payload = ack.payload as { current_count: number };
    expect(payload.current_count).toBe(1);

    conn.ws.close();
  });

  it('watch_fs_remove drops the subscription and acks updated watched_paths', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r.address));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wadd',
        payload: { session_id: sid, paths: ['src', 'docs'] },
      }),
    );
    await receiveType(conn, 'ack', 1000);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_remove',
        id: 'wrm',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    const payload = ack.payload as { watched_paths: string[]; current_count: number };
    expect(payload.watched_paths).toEqual(['docs']);
    expect(payload.current_count).toBe(1);

    conn.ws.close();
  });

  it('41304: watch_fs_add for `..` path → fs.path_escapes_session', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r.address));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'wbad',
        payload: { session_id: sid, paths: ['../escape'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(41304);

    conn.ws.close();
  });
});
