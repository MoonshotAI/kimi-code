/**
 * `event.fs.changed` end-to-end for kap-server (server-v2), engine mode.
 *
 * Engine mode (the only mode): session fs is owned by the Rust engine, so the
 * host fs-watch bridge is a deliberate **no-op** — it acks every `watch_fs_add`
 * / `watch_fs_remove` request so WS clients don't retry, without actually
 * watching the filesystem (`FsWatchBridge`). The v2 `ISessionFsWatchService`
 * feed (real chokidar delivery, path-escape / limit validation, dedup,
 * truncated bursts) was retired with the engine migration. These tests pin the
 * no-op contract: acks carry the request echo, but no `event.fs.changed` is
 * ever emitted and no limit/escape errors are produced.
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

/** No-op bridge acks everything; the ack payload echoes the requested paths. */
describe('WS fs watch (kap-server, engine-mode no-op bridge)', () => {
  it('acknowledges watch_fs_add with the request echo but never emits fs events', async () => {
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
    expect(ack.payload).toMatchObject({ watched_paths: ['src'], current_count: 1 });

    // The bridge holds no fs subscriptions, so mutations produce no events.
    writeFileSync(join(workspace, 'src', 'new.ts'), 'export const x = 1;\n');
    await expect(receiveType(conn, 'event.fs.changed', 500)).rejects.toThrow(/no message/);

    conn.ws.close();
  });

  it('acks multiple disjoint adds (no cross-client isolation state in engine mode)', async () => {
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
    const ackB = await receiveType(b, 'ack', 1000);
    expect(ackB.code).toBe(0);
    expect((ackB.payload as { current_count: number }).current_count).toBe(1);

    a.ws.close();
    b.ws.close();
  });

  it('acks >100 paths without a limit error (no-op bridge enforces nothing)', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    const paths: string[] = [];
    for (let i = 0; i < 101; i++) {
      paths.push(`dir${i}`);
    }
    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_add',
        id: 'w101',
        payload: { session_id: sid, paths },
      }),
    );
    const ack = await receiveType(conn, 'ack', 2000);
    expect(ack.code).toBe(0);
    expect((ack.payload as { current_count: number }).current_count).toBe(101);

    conn.ws.close();
  });

  it('watch_fs_remove acks with an empty watched_paths (no retained state)', async () => {
    const r = await boot();
    const sid = await createSession(r);
    const conn = await openConn(wsUrl(r));
    await helloAndSubscribe(conn, 'A', sid);

    conn.ws.send(
      JSON.stringify({
        type: 'watch_fs_remove',
        id: 'wrm',
        payload: { session_id: sid, paths: ['src'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);
    const payload = ack.payload as { watched_paths: string[]; current_count: number };
    expect(payload.watched_paths).toEqual([]);
    expect(payload.current_count).toBe(0);

    conn.ws.close();
  });

  it('does not reject a `..` path (no path-escape validation in engine mode)', async () => {
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
    expect(ack.code).toBe(0);

    conn.ws.close();
  });
});
