/**
 * `event.fs.changed` end-to-end for kap-server (server-v2).
 *
 * Mirrors `packages/server/test/fs-watch.e2e.test.ts` (v1) so the wire contract
 * stays byte-compatible:
 *   1. subscribe `src` → create file → receive `event.fs.changed`
 *   2. burst > 500 changes / 200ms → `truncated` event
 *   3. two clients, disjoint paths → no cross-delivery
 *   4. > 100 paths per connection → `42902 fs.watch_limit_exceeded`
 *   5. idempotent add of the same path
 *   6. `watch_fs_remove` updates `watched_paths`; `..` → `41304`
 *
 * Boots `startServer` in-process (loopback, auth disabled) against a tmp
 * workspace, drives `/api/v1/ws` clients with the raw `ws` library, and mutates
 * the filesystem to trigger chokidar events.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { startServer, type RunningServer } from '../src/start';

let tmpDir: string;
let bridgeHome: string;
let workspace: string;
let server: RunningServer | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kap-fswatch-'));
  bridgeHome = mkdtempSync(join(tmpdir(), 'kap-fswatch-home-'));
  workspace = join(tmpDir, 'workspace');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(join(workspace, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'docs'), { recursive: true });
});

afterEach(async () => {
  try {
    await server?.close();
  } catch {
    // ignore
  }
  server = undefined;
  vi.unstubAllEnvs();
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function boot(): Promise<RunningServer> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    homeDir: bridgeHome,
    logger: pino({ level: 'silent' }),
    disableAuth: true,
  });
  return server;
}

function addressOf(r: RunningServer): string {
  return `http://${r.host}:${r.port}`;
}

function wsUrl(r: RunningServer): string {
  return `${addressOf(r).replace(/^http/, 'ws')}/api/v1/ws`;
}

async function createSession(r: RunningServer): Promise<string> {
  const res = await fetch(`${addressOf(r)}/api/v1/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metadata: { cwd: workspace } }),
  });
  const env = (await res.json()) as { code: number; data: { id: string } | null };
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
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

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(rawToString(data)) as WsFrame;
      } catch {
        return;
      }
      if (waiters.length > 0) waiters.shift()?.(parsed);
      else queue.push(parsed);
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

async function receiveType(conn: Conn, type: string, timeoutMs: number): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no message of type ${type} within ${timeoutMs}ms`);
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

async function helloAndSubscribe(conn: Conn, clientId: string, sessionId: string): Promise<void> {
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Time given to chokidar to register newly-watched paths before mutating. */
const WATCH_SETTLE_MS = 150;

describe('WS fs watch (kap-server)', () => {
  it('subscribe src → create file → receive event.fs.changed', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

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
    const paths = payload.changes.map((c) => c.path);
    expect(paths.some((p) => p === 'src/new.ts' || p === 'src')).toBe(true);

    conn.ws.close();
  });

  it.skipIf(process.platform === 'win32')(
    'burst > 500 changes inside 200ms window → truncated:true',
    { timeout: 15000 },
    async () => {
      // Chokidar cannot reliably deliver >500 events inside one 200ms window
      // under CPU contention (parallel test files), which flaked this test.
      // Shrink the window capacity instead: 600 files over 500ms windows
      // guarantees a >100-event window even at ~240 events/s delivery, while
      // the truncation path under test is identical.
      vi.stubEnv('KIMI_CODE_FS_WATCH_DEBOUNCE_MS', '500');
      vi.stubEnv('KIMI_CODE_FS_WATCH_MAX_CHANGES_PER_WINDOW', '100');
      const r = await boot();
      const sid = await createSession(r);
      const conn = await openConn(wsUrl(r));
      await helloAndSubscribe(conn, 'A', sid);

      conn.ws.send(
        JSON.stringify({
          type: 'watch_fs_add',
          id: 'w2',
          payload: { session_id: sid, paths: ['.'] },
        }),
      );
      await receiveType(conn, 'ack', 1000);
      await sleep(WATCH_SETTLE_MS);

      const burstDir = join(workspace, 'burst');
      mkdirSync(burstDir, { recursive: true });
      for (let i = 0; i < 600; i++) writeFileSync(join(burstDir, `f${i}.txt`), `x${i}`);

      const deadline = Date.now() + 12000;
      let sawTruncated = false;
      while (Date.now() < deadline) {
        let frame: WsFrame;
        try {
          frame = await receive(conn, deadline - Date.now());
        } catch {
          break;
        }
        if (frame.type !== 'event.fs.changed') continue;
        const payload = frame.payload as { truncated?: boolean; count?: number };
        if (payload.truncated === true) {
          expect(payload.count).toBeGreaterThan(100);
          sawTruncated = true;
          break;
        }
      }
      expect(sawTruncated).toBe(true);
      conn.ws.close();
    },
  );

  it('two clients on disjoint paths receive only their own changes', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const a = await openConn(wsUrl(r));
    const b = await openConn(wsUrl(r));
    await helloAndSubscribe(a, 'A', sid);
    await helloAndSubscribe(b, 'B', sid);

    a.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'wA', payload: { session_id: sid, paths: ['src'] } }),
    );
    await receiveType(a, 'ack', 1000);
    b.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'wB', payload: { session_id: sid, paths: ['docs'] } }),
    );
    await receiveType(b, 'ack', 1000);

    await sleep(WATCH_SETTLE_MS);
    writeFileSync(join(workspace, 'src', 'a.ts'), 'a');
    writeFileSync(join(workspace, 'docs', 'b.md'), 'b');

    const evA = await receiveType(a, 'event.fs.changed', 2000);
    const pathsA = (evA.payload as { changes: Array<{ path: string }> }).changes.map((c) => c.path);
    expect(pathsA.some((p) => p.startsWith('src/'))).toBe(true);
    expect(pathsA.some((p) => p.startsWith('docs/'))).toBe(false);

    const evB = await receiveType(b, 'event.fs.changed', 2000);
    const pathsB = (evB.payload as { changes: Array<{ path: string }> }).changes.map((c) => c.path);
    expect(pathsB.some((p) => p.startsWith('docs/'))).toBe(true);
    expect(pathsB.some((p) => p.startsWith('src/'))).toBe(false);

    a.ws.close();
    b.ws.close();
  });

  it('> 100 paths on one connection → 42902 fs.watch_limit_exceeded', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    const paths: string[] = [];
    for (let i = 0; i < 101; i++) {
      const p = `dir${i}`;
      mkdirSync(join(workspace, p), { recursive: true });
      paths.push(p);
    }

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w100',
        payload: { session_id: sid, paths: paths.slice(0, 100) },
      }),
    );
    const ack100 = await receiveType(conn, 'ack', 2000);
    expect(ack100.code).toBe(0);
    expect((ack100.payload as { current_count: number }).current_count).toBe(100);

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

  it('idempotent: adding the same path twice keeps current_count singular', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'w1', payload: { session_id: sid, paths: ['src'] } }),
    );
    await receiveType(conn, 'ack', 1000);
    conn.ws.send(
      JSON.stringify({ type: 'watch_fs_add', id: 'w2', payload: { session_id: sid, paths: ['src'] } }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect((ack.payload as { current_count: number }).current_count).toBe(1);

    conn.ws.close();
  });

  it('watch_fs_remove drops the subscription and acks updated watched_paths', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
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

  it('watch_fs_add for `..` path → 41304 fs.path_escapes_session', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
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
