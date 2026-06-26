/**
 * Production auth wiring end-to-end (ROADMAP M5.1).
 *
 * Unlike the override-driven tests (which inject a fixed-token
 * `IAuthTokenService`), this file boots `startServer` with NO auth override so
 * the REAL `defaultAuth` is built: a persistent token written to
 * `<homeDir>/server.token` (0600) plus the HTTP/WS auth hooks. The token
 * is read back from disk — exactly what the CLI does (M5.4) — and exercised
 * against a gated HTTP route and the WS upgrade path. This proves the
 * production wiring, not just the override seam.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { startServer, type RunningServer } from '../src';
import { rawDataToString } from '../src/ws/rawData';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
const running: RunningServer[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-auth-wiring-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-auth-wiring-home-'));
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

function tokenPath(): string {
  return join(bridgeHome, 'server.token');
}

function readToken(): string {
  return readFileSync(tokenPath(), 'utf8').trim();
}

async function bootReal(): Promise<RunningServer> {
  const r = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
  });
  running.push(r);
  return r;
}

function wsUrl(http: string): string {
  return http.replace(/^http:\/\//, 'ws://') + '/api/v1/ws';
}

interface WsFrame {
  type: string;
  [k: string]: unknown;
}

interface Conn {
  ws: WebSocket;
  queue: WsFrame[];
  waiters: Array<(frame: WsFrame) => void>;
  closed: Promise<{ code: number; reason: string }>;
}

function openConn(url: string, protocols?: string[]): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    const queue: WsFrame[] = [];
    const waiters: Array<(frame: WsFrame) => void> = [];
    let closedResolve: (v: { code: number; reason: string }) => void;
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      closedResolve = res;
    });
    // Attach the message listener BEFORE 'open' can fire so the immediate
    // `server_hello` frame is never dropped.
    ws.on('message', (data: RawData) => {
      try {
        const frame = JSON.parse(rawDataToString(data)) as WsFrame;
        if (waiters.length > 0) waiters.shift()?.(frame);
        else queue.push(frame);
      } catch {
        // ignore non-JSON frames
      }
    });
    ws.on('close', (code, reason) => closedResolve({ code, reason: String(reason) }));
    ws.once('open', () => resolve({ ws, queue, waiters, closed }));
    ws.once('error', reject);
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
      reject(new Error(`no message within ${timeoutMs}ms`));
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

function expectRejected(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(
      () => done(new Error('connection was not rejected within timeout')),
      1500,
    );
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      if (err === undefined) {
        resolve();
      } else {
        reject(err);
      }
    };
    ws.once('open', () => done(new Error('connection unexpectedly opened')));
    ws.once('error', () => done());
    ws.once('close', () => done());
  });
}

describe('production auth wiring (M5.1)', () => {
  it.skipIf(process.platform === 'win32')('writes a 0600 token file at boot and keeps it on close (persistent)', async () => {
    const r = await bootReal();
    const p = tokenPath();

    const info = statSync(p);
    expect(info.mode & 0o777).toBe(0o600);

    const token = readToken();
    expect(token.length).toBeGreaterThan(0);

    await r.close();
    // Persistent token: the file survives shutdown so the next start reuses it.
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('gates HTTP: 200 with the token, 401 without', async () => {
    const r = await bootReal();
    const token = readToken();

    const ok = await fetch(`${r.address}/openapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${r.address}/openapi.json`);
    expect(bad.status).toBe(401);
    const body = (await bad.json()) as { code: number };
    expect(body.code).toBe(40101);
  });

  it('gates WS: server_hello with the token, rejected without', async () => {
    const r = await bootReal();
    const token = readToken();

    const conn = await openConn(wsUrl(r.address), [`kimi-code.bearer.${token}`]);
    const hello = await receiveType(conn, 'server_hello', 1000);
    expect(hello.type).toBe('server_hello');
    conn.ws.close();
    await conn.closed;

    await expectRejected(wsUrl(r.address));
  });
});
