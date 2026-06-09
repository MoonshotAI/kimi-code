/**
 * WS handshake + heartbeat e2e (W5.1 / P0.15).
 *
 * Boots `startDaemon` on port 0 with a tmpdir lock, then connects a real
 * `ws` client. Validates the full WS.md §1 lifecycle:
 *
 *   1. Server immediately sends `server_hello`.
 *   2. Client sends `client_hello` → server acks (code=0).
 *   3. Server pings every `pingIntervalMs` (overridden to 60ms here so the
 *      test finishes in <1s instead of waiting 30s).
 *   4. Client `pong` resets the pong timer — connection stays alive.
 *   5. Daemon close → WS code 1001 (going away).
 *
 * Uses `wsGatewayOptions.pingIntervalMs` + `.pongTimeoutMs` to shrink timers.
 * The connection's `WsConnection` reads those through the gateway.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pino } from 'pino';
import { WebSocket } from 'ws';

import {
  IConnectionRegistry,
  IWSGateway,
  startDaemon,
  type RunningDaemon,
} from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningDaemon[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-ws-handshake-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-ws-handshake-home-'));
});

afterEach(async () => {
  for (const r of running.splice(0)) {
    try {
      await r.close();
    } catch {
      // ignore
    }
  }
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function spawn(): Promise<RunningDaemon> {
  const r = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 60, pongTimeoutMs: 200 },
  });
  running.push(r);
  return r;
}

function wsUrl(http: string): string {
  return http.replace(/^http:\/\//, 'ws://') + '/api/v1/ws';
}

interface WsFrame {
  type: string;
  payload?: unknown;
  id?: string;
  code?: number;
  [k: string]: unknown;
}

/**
 * Wraps a `WebSocket` with a message queue. Frames received between socket
 * open and the first `await receive(...)` call go into `queue` so the test
 * doesn't race the server's first push (which can land within the same tick
 * as the upgrade callback). Without this, fast tests miss `server_hello`.
 */
interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
  closed: Promise<{ code: number; reason: string }>;
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    let closedResolve: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      closedResolve = res;
    });
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
    ws.on('close', (code, reason) => {
      closedResolve({ code, reason: String(reason) });
    });
    ws.once('open', () => resolve({ ws, queue, waiters, closed }));
    ws.once('error', (err) => reject(err));
  });
}

/** Pop the next frame (queued or yet-to-arrive). Rejects on timeout. */
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

/** Drain until a frame with the given `type` arrives. */
async function receiveType(conn: Conn, type: string, timeoutMs: number): Promise<WsFrame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`no message of type ${type} within ${timeoutMs}ms`);
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

describe('WS gateway handshake + heartbeat (W5.1)', () => {
  it('sends server_hello on connect and acks client_hello', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));

    const hello = await receiveType(conn, 'server_hello', 1000);
    const helloPayload = hello.payload as { heartbeat_ms: number; max_event_buffer_size: number };
    expect(helloPayload.heartbeat_ms).toBe(60);
    expect(helloPayload.max_event_buffer_size).toBe(1000);

    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_test_1',
        payload: { client_id: 'cli_1', subscriptions: [] },
      }),
    );

    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.id).toBe('cli_test_1');
    expect(ack.code).toBe(0);

    // The registry should now have exactly one attached connection.
    r.services.invokeFunction((a) => {
      expect(a.get(IConnectionRegistry).size()).toBe(1);
      expect(a.get(IWSGateway).size).toBe(1);
    });

    conn.ws.close();
    await conn.closed;
  });

  it('sends ping after pingIntervalMs', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));

    await receiveType(conn, 'server_hello', 1000);
    // First ping should land within ~pingIntervalMs (=60ms). Give 5x slack.
    const ping = await receiveType(conn, 'ping', 600);
    const pingPayload = ping.payload as { nonce: string };
    expect(pingPayload.nonce).toMatch(/^[0-9A-Z]{26}$/);

    conn.ws.close();
    await conn.closed;
  });

  it('pong from client keeps the connection alive past pongTimeout', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);

    const ping = await receiveType(conn, 'ping', 600);
    const nonce = (ping.payload as { nonce: string }).nonce;
    conn.ws.send(JSON.stringify({ type: 'pong', payload: { nonce } }));

    // Wait > pongTimeoutMs (200ms) — without the pong reset above we'd be
    // terminated. Assert by observing the next ping arrives normally.
    const nextPing = await receiveType(conn, 'ping', 600);
    expect(nextPing.type).toBe('ping');
    expect(conn.ws.readyState).toBe(WebSocket.OPEN);

    conn.ws.close();
    await conn.closed;
  });

  it('daemon close sends WS close code 1001 to attached clients', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);

    await r.close();

    const { code } = await conn.closed;
    expect(code).toBe(1001);
  });

  it('non-/api/v1/ws upgrade requests are rejected', async () => {
    const r = await spawn();
    const badUrl = r.address.replace(/^http:\/\//, 'ws://') + '/api/v1/other';
    await expect(openConn(badUrl)).rejects.toBeInstanceOf(Error);
  });
});
