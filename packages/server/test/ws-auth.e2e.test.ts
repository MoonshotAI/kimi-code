/**
 * WS upgrade auth (ROADMAP M3).
 *
 * M3.1 adds the `kimi-code.bearer.<token>` subprotocol parser; M3.2 wires it
 * into the upgrade path. The parser is exercised as pure unit cases first; the
 * upgrade-path cases boot `startServer` with a fixed-token
 * `IAuthTokenService` injected through `wsGatewayOptions.authTokenService`.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { startServer, type RunningServer } from '../src';
import { IAuthTokenService } from '../src/services/auth/authTokenService';
import { extractWsBearerToken } from '../src/services/gateway/wsGateway';
import { rawDataToString } from '../src/ws/rawData';

describe('extractWsBearerToken', () => {
  it('returns undefined for a missing header', () => {
    expect(extractWsBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty header', () => {
    expect(extractWsBearerToken('')).toBeUndefined();
  });

  it('extracts the token from a single bearer subprotocol', () => {
    expect(extractWsBearerToken('kimi-code.bearer.TOKEN')).toBe('TOKEN');
  });

  it('finds the bearer subprotocol among a comma-separated list', () => {
    expect(extractWsBearerToken('other, kimi-code.bearer.TOKEN2')).toBe('TOKEN2');
  });

  it('returns undefined for an empty token', () => {
    expect(extractWsBearerToken('kimi-code.bearer.')).toBeUndefined();
  });

  it('returns undefined when no subprotocol matches', () => {
    expect(extractWsBearerToken('unrelated')).toBeUndefined();
  });
});

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
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-server-ws-auth-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-server-ws-auth-home-'));
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

/** Accepts exactly `'test-token'`; mirrors the fixed-token seam used in M2. */
const fixedTokenAuth: IAuthTokenService = {
  _serviceBrand: undefined,
  getToken: () => 'test-token',
  isValid: async (candidate) => candidate === 'test-token',
};

async function spawn(): Promise<RunningServer> {
  const r = await startServer({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    coreProcessOptions: { homeDir: bridgeHome },
    wsGatewayOptions: {
      pingIntervalMs: 60,
      pongTimeoutMs: 200,
    },
    // Inject the fixed token via the DI seam (M5.1 reads it through the WS
    // gateway's `setAuthTokenService`, no longer via `wsGatewayOptions`).
    serviceOverrides: [[IAuthTokenService, fixedTokenAuth]],
  });
  running.push(r);
  return r;
}

function wsUrl(http: string): string {
  return http.replace(/^http:\/\//, 'ws://') + '/api/v1/ws';
}

function openConn(url: string, opts?: ConnectOptions): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
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

/**
 * Asserts the upgrade is rejected (the socket errors/closes without ever
 * opening, so no `server_hello` is received). Resolves on the first `error` or
 * `close`; rejects if the socket opens or nothing happens within the timeout.
 */
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

describe('ws upgrade auth', () => {
  it('accepts a valid bearer subprotocol and echoes it', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address), {
      protocols: ['kimi-code.bearer.test-token'],
    });

    await receiveType(conn, 'server_hello', 1000);
    expect(conn.ws.protocol).toBe('kimi-code.bearer.test-token');

    conn.ws.close();
    await conn.closed;
  });

  it('accepts a valid Authorization bearer header', async () => {
    const r = await spawn();
    const conn = await openConn(wsUrl(r.address), {
      headers: { Authorization: 'Bearer test-token' },
    });

    const hello = await receiveType(conn, 'server_hello', 1000);
    expect(hello.type).toBe('server_hello');

    conn.ws.close();
    await conn.closed;
  });

  it('rejects a wrong bearer token without server_hello', async () => {
    const r = await spawn();
    await expectRejected(wsUrl(r.address), {
      protocols: ['kimi-code.bearer.wrong'],
    });
  });

  it('rejects a connection with no token', async () => {
    const r = await spawn();
    await expectRejected(wsUrl(r.address));
  });

  it('rejects upgrades to a non-/api/v1/ws path', async () => {
    const r = await spawn();
    const badUrl = r.address.replace(/^http:\/\//, 'ws://') + '/api/v1/other';
    await expectRejected(badUrl, { protocols: ['kimi-code.bearer.test-token'] });
  });
});
