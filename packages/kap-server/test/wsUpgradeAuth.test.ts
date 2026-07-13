/**
 * WebSocket upgrade-time auth (port of v1 `ws-auth.e2e.test.ts`).
 *
 * Both `/api/v1/ws` and `/api/v2/ws` require a valid bearer credential at the
 * HTTP `upgrade` (matching v1's wsGatewayService): a token-less or invalid
 * upgrade is rejected with 401 before the socket completes the handshake. The
 * credential is the persistent bearer token (or, when configured, the
 * `rpcToken`); it may ride on the `Authorization` header or the
 * `kimi-code.bearer.<token>` subprotocol.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { fixedTokenAuth } from './helpers/fixedAuth';

const TOKEN = 'test-token';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

interface ConnectOptions {
  readonly protocols?: string[];
  readonly headers?: Record<string, string>;
}

/** Resolve when the socket opens and the server's first frame arrives. */
function openConn(url: string, opts?: ConnectOptions): Promise<{ ws: WebSocket; firstFrame: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    ws.once('message', (data) => {
      try {
        resolve({ ws, firstFrame: JSON.parse(rawToString(data)) });
      } catch {
        resolve({ ws, firstFrame: null });
      }
    });
    ws.once('error', reject);
  });
}

/** Resolve when the upgrade is rejected (error or close without ever opening). */
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

describe('WS upgrade auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let v1Url: string;
  let v2Url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ws-upgrade-auth-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
    });
    v1Url = `ws://127.0.0.1:${server.port}/api/v1/ws`;
    v2Url = `ws://127.0.0.1:${server.port}/api/v2/ws`;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  describe.each([
    ['/api/v1/ws', 'v1Url', 'server_hello'],
    ['/api/v2/ws', 'v2Url', 'ready'],
  ] as const)('%s', (_path, urlKey, firstType) => {
    const url = (): string => (urlKey === 'v1Url' ? v1Url : v2Url);

    it('accepts a valid bearer subprotocol and echoes it', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        protocols: [`kimi-code.bearer.${TOKEN}`],
      });
      sockets.push(ws);
      expect(ws.protocol).toBe(`kimi-code.bearer.${TOKEN}`);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('accepts a valid Authorization bearer header', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      sockets.push(ws);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('rejects a wrong bearer token', async () => {
      await expectRejected(url(), { protocols: ['kimi-code.bearer.wrong'] });
    });

    it('rejects a connection with no token', async () => {
      await expectRejected(url());
    });
  });

  it('rejects upgrades to a non-WS path', async () => {
    const badUrl = `ws://127.0.0.1:${(server as RunningServer).port}/api/v1/other`;
    await expectRejected(badUrl, { protocols: [`kimi-code.bearer.${TOKEN}`] });
  });
});
