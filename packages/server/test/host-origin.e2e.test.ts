/**
 * Host / Origin checks wired into HTTP + WS (ROADMAP M4.3).
 *
 * HTTP: the global `onRequest` Host hook rejects `Host: evil.com` with 403
 * before any route handler (here `/api/v1/healthz`), while the default
 * `127.0.0.1:<port>` Host from a real `fetch` is allowed.
 *
 * WS: `wsGatewayOptions.hostCheck` / `allowedOrigins` gate the upgrade path
 * before token validation. `authTokenService` is intentionally left unset so
 * these cases isolate Host/Origin from token auth. The Node `ws` client sends
 * no `Origin` by default, which is treated as a non-browser client and
 * allowed; a spoofed browser `Origin: http://evil.com` is rejected.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { startServer, type RunningServer } from '../src';
import type { WSGatewayOptions } from '../src/services/gateway/wsGateway';
import { rawDataToString } from '../src/ws/rawData';
import { fixedTokenAuth } from './helpers/serverHarness';

interface WsFrame {
  type: string;
  payload?: unknown;
  [k: string]: unknown;
}

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
  closed: Promise<{ code: number; reason: string }>;
}

interface ConnectOptions {
  protocols?: string[];
  headers?: Record<string, string>;
}

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningServer[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-host-origin-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-host-origin-home-'));
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

async function spawn(wsGatewayOptions?: WSGatewayOptions): Promise<RunningServer> {
  const r = await startServer({
    serviceOverrides: [fixedTokenAuth()],
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    ...(wsGatewayOptions !== undefined ? { wsGatewayOptions } : {}),
  });
  running.push(r);
  return r;
}

function wsUrl(http: string): string {
  return http.replace(/^http:\/\//, 'ws://') + '/api/v1/ws';
}

/**
 * Raw HTTP GET that lets us set an arbitrary `Host` header. Node's `fetch`
 * (undici) treats `Host` as a forbidden header and silently replaces it with
 * the URL host, so we drive `node:http` directly to exercise the Host check.
 */
function rawHttpGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function openConn(url: string, opts?: ConnectOptions): Promise<Conn> {
  return new Promise((resolve, reject) => {
    // Offer the fixed bearer token so the M5.1 WS auth passes; the Host/Origin
    // cases that expect rejection use `expectRejected` (no token) instead.
    const protocols = [...(opts?.protocols ?? []), 'kimi-code.bearer.test-token'];
    const ws = new WebSocket(url, protocols, { headers: opts?.headers });
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

function expectRejected(url: string, opts?: ConnectOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      if (err !== undefined) reject(err);
      else resolve();
    };
    const t = setTimeout(
      () => done(new Error('connection was not rejected within timeout')),
      1500,
    );
    ws.once('open', () => done(new Error('connection unexpectedly opened')));
    ws.once('error', () => done());
    ws.once('close', () => done());
  });
}

describe('HTTP Host check (start.ts)', () => {
  it('rejects Host: evil.com with 403 before the route handler', async () => {
    const r = await spawn();
    const res = await rawHttpGet(`${r.address}/api/v1/healthz`, { Host: 'evil.com' });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body['code']).toBe(40301);
    expect(body['msg']).toBe(
      "Invalid Host header: evil.com; allow this host with KIMI_CODE_ALLOWED_HOSTS=evil.com or 'kimi server run --allowed-host evil.com'.",
    );
  });

  it('allows the default 127.0.0.1:<port> Host', async () => {
    const r = await spawn();
    const res = await rawHttpGet(`${r.address}/api/v1/healthz`, {});
    expect(res.status).toBe(200);
  });
});

describe('WS Host/Origin checks (wsGatewayService)', () => {
  it('rejects a spoofed Host before token validation', async () => {
    const r = await spawn({ hostCheck: { boundHost: '127.0.0.1' }, allowedOrigins: [] });
    await expectRejected(wsUrl(r.address), { headers: { Host: 'evil.com' } });
  });

  it('accepts a normal Host and delivers server_hello', async () => {
    const r = await spawn({ hostCheck: { boundHost: '127.0.0.1' }, allowedOrigins: [] });
    const conn = await openConn(wsUrl(r.address));
    const hello = await receiveType(conn, 'server_hello', 1000);
    expect(hello.type).toBe('server_hello');
    conn.ws.close();
    await conn.closed;
  });

  it('rejects a disallowed browser Origin', async () => {
    const r = await spawn({ hostCheck: { boundHost: '127.0.0.1' }, allowedOrigins: [] });
    await expectRejected(wsUrl(r.address), {
      headers: { origin: 'http://evil.com' },
    });
  });

  it('allows a Node client with no Origin (present-only check)', async () => {
    const r = await spawn({ hostCheck: { boundHost: '127.0.0.1' }, allowedOrigins: [] });
    const conn = await openConn(wsUrl(r.address));
    const hello = await receiveType(conn, 'server_hello', 1000);
    expect(hello.type).toBe('server_hello');
    conn.ws.close();
    await conn.closed;
  });

  it('skips the checks when the options are unset', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address));
    const hello = await receiveType(conn, 'server_hello', 1000);
    expect(hello.type).toBe('server_hello');
    conn.ws.close();
    await conn.closed;
  });
});
