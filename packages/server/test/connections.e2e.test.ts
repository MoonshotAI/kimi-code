/**
 * `GET /api/v1/connections` end-to-end (kimi server ps wire contract).
 *
 * Boots the real server on port 0 with a tmpdir lock, attaches real `ws`
 * clients to `/api/v1/ws`, then reads the connection list back through the
 * REST endpoint via Fastify's `inject` simulator.
 *
 * Asserts:
 *   1. Empty list when no clients are attached.
 *   2. A raw socket (no `client_hello`) shows up with `has_client_hello: false`,
 *      a loopback `remote_address`, and a valid `connected_at`.
 *   3. After `client_hello` with subscriptions, the row reflects
 *      `has_client_hello: true` and the subscribed session ids.
 *   4. Once the socket closes, the row disappears (registry removal works).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectionsListResponseSchema } from '@moonshot-ai/protocol';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  IConnectionRegistry,
  IRestGateway,
  startServer,
  type RunningServer,
} from '../src';
import { fixedTokenAuth } from './helpers/serverHarness';
import { rawDataToString } from '../src/ws/rawData';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningServer[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-connections-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-connections-home-'));
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

async function spawn(): Promise<RunningServer> {
  const r = await startServer({
    serviceOverrides: [fixedTokenAuth()],
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

/** Pull the Fastify instance off the running server for hermetic REST injects. */
function appOf(r: RunningServer): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  const app = r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
};
  });
  // Auto-attach the fixed bearer token so the M5.1 auth hook passes. A
  // caller-supplied `authorization` header wins, so explicit token tests keep
  // working; every other header (Range, content-type, …) is preserved.
  return {
    inject(req: unknown) {
      const q = req as { headers?: Record<string, string | string[] | undefined> };
      return app.inject({
        ...q,
        headers: { authorization: 'Bearer test-token', ...q.headers },
      });
    },
  };
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

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
  closed: Promise<{ code: number; reason: string }>;
}

function openConn(url: string): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['kimi-code.bearer.test-token']);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    let closedResolve: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      closedResolve = res;
    });
    ws.on('message', (data) => {
      let parsed: WsFrame;
      try {
        parsed = JSON.parse(rawDataToString(data)) as WsFrame;
      } catch {
        return;
      }
      if (waiters.length > 0) {
        waiters.shift()?.(parsed);
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

function receive(conn: Conn, timeoutMs: number): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    if (conn.queue.length > 0) {
      resolve(conn.queue.shift()!);
      return;
    }
    const t = setTimeout(() => {
      const idx = conn.waiters.indexOf(waiter);
      if (idx >= 0) conn.waiters.splice(idx, 1);
      reject(new Error(`no message in ${String(timeoutMs)}ms`));
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
    if (remaining <= 0) throw new Error(`no message of type ${type} within ${String(timeoutMs)}ms`);
    const frame = await receive(conn, remaining);
    if (frame.type === type) return frame;
  }
}

async function waitForRegistrySize(
  r: RunningServer,
  target: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = r.services.invokeFunction((a) => a.get(IConnectionRegistry).size());
    if (size === target) return;
    await new Promise((res) => {
      setTimeout(res, 10);
    });
  }
  throw new Error(`registry size ${String(target)} not observed within ${String(timeoutMs)}ms`);
}

describe('GET /api/v1/connections', () => {
  it('returns an empty list when no clients are attached', async () => {
    const r = await spawn();
    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/connections' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body['code']).toBe(0);
    expect(body['msg']).toBe('success');
    expect(typeof body['request_id']).toBe('string');

    const parsed = connectionsListResponseSchema.parse(body['data']);
    expect(parsed.connections).toEqual([]);
  });

  it('lists a raw connection without client_hello', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/connections' });
    const body = res.json() as Record<string, unknown>;
    const { connections } = connectionsListResponseSchema.parse(body['data']);

    expect(connections).toHaveLength(1);
    const c = connections[0]!;
    expect(c.id).toMatch(/^conn_/);
    expect(c.has_client_hello).toBe(false);
    expect(c.subscriptions).toEqual([]);
    expect(c.connected_at).toMatch(/Z$/);
    // Real loopback socket — server saw a peer address.
    expect(typeof c.remote_address).toBe('string');
    expect((c.remote_address ?? '').length).toBeGreaterThan(0);

    conn.ws.close();
    await conn.closed;
  });

  it('reflects client_hello handshake and subscriptions', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);

    conn.ws.send(
      JSON.stringify({
        type: 'client_hello',
        id: 'cli_test_1',
        payload: { client_id: 'cli_1', subscriptions: ['sess_test_1'] },
      }),
    );
    const ack = await receiveType(conn, 'ack', 1000);
    expect(ack.code).toBe(0);

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/connections' });
    const body = res.json() as Record<string, unknown>;
    const { connections } = connectionsListResponseSchema.parse(body['data']);

    expect(connections).toHaveLength(1);
    const c = connections[0]!;
    expect(c.has_client_hello).toBe(true);
    expect(c.subscriptions).toContain('sess_test_1');

    conn.ws.close();
    await conn.closed;
  });

  it('removes the connection after the socket closes', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));
    await receiveType(conn, 'server_hello', 1000);

    conn.ws.close();
    await conn.closed;
    await waitForRegistrySize(r, 0, 1000);

    const res = await appOf(r).inject({ method: 'GET', url: '/api/v1/connections' });
    const body = res.json() as Record<string, unknown>;
    const { connections } = connectionsListResponseSchema.parse(body['data']);
    expect(connections).toEqual([]);
  });
});
