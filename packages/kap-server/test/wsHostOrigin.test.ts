/**
 * WebSocket upgrade Host/Origin checks (port of v1 `host-origin.e2e.test.ts`).
 *
 * The raw HTTP `upgrade` event bypasses Fastify's `onRequest` hooks, so the
 * Host and Origin allowlists are enforced explicitly in the upgrade handler
 * (matching v1's wsGatewayService) — and BEFORE token validation. A spoofed
 * Host or a disallowed browser Origin is rejected with 403; a missing Origin
 * is treated as a non-browser client and allowed (present-only).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { fixedTokenAuth } from './helpers/fixedAuth';

const TOKEN = 'test-token';

interface ConnectOptions {
  readonly headers?: Record<string, string>;
}

function openConn(url: string, opts?: ConnectOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${TOKEN}`], { headers: opts?.headers });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function expectRejected(url: string, opts?: ConnectOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, [`kimi-code.bearer.${TOKEN}`], { headers: opts?.headers });
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

describe('WS upgrade Host/Origin checks', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let v1Url: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ws-host-origin-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
    });
    v1Url = `ws://127.0.0.1:${server.port}/api/v1/ws`;
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

  describe('/api/v1/ws', () => {
    const url = (): string => v1Url;

    it('rejects a spoofed Host before token validation', async () => {
      await expectRejected(url(), { headers: { Host: 'evil.com' } });
    });

    it('rejects a disallowed browser Origin', async () => {
      await expectRejected(url(), { headers: { origin: 'http://evil.com' } });
    });

    it('allows a normal Host and a Node client with no Origin', async () => {
      const ws = await openConn(url());
      sockets.push(ws);
      expect(ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  it('allows an explicitly allowed Origin', async () => {
    await server?.close();
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
      corsOrigins: ['https://app.example.test'],
    });
    const url = `ws://127.0.0.1:${server.port}/api/v1/ws`;
    const ws = await openConn(url, { headers: { origin: 'https://app.example.test' } });
    sockets.push(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });
});
