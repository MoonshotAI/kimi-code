/**
 * `GET /api/v1/connections` (server-v2) — wire-contract test.
 *
 * Adapted from v1's `connections.e2e.test.ts`. server-v2 does not serve
 * `/api/v1/ws`, so the clients listed here are attached to `/api/v2/ws`. The
 * no-handshake case uses a raw `ws` socket (no `hello`); the handshake +
 * subscription cases use `WsClient` (which sends `hello`) and a session-scoped
 * `listen`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connectionsListResponseSchema } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { WsClient } from '../src/transport/ws/wsClient';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

describe('server-v2 GET /api/v1/connections', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-connections-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
    wsUrl = `ws://127.0.0.1:${server.port}/api/v2/ws`;
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  async function listConnections() {
    const res = await fetch(`${base}/api/v1/connections`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.code).toBe(0);
    return connectionsListResponseSchema.parse(body.data).connections;
  }

  async function createSession(cwd: string): Promise<string> {
    const res = await fetch(`${base}/api/v1/sessions`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer, { 'content-type': 'application/json' }),
      body: JSON.stringify({ metadata: { cwd } }),
    } as never);
    const body = (await res.json()) as Envelope<{ id: string }>;
    expect(body.code).toBe(0);
    return body.data.id;
  }

  /** Open a raw WS and resolve on the server's first (`ready`) frame — no `hello`. */
  function openRaw(): Promise<{ ws: WebSocket; closed: Promise<void> }> {
    return new Promise((resolve, reject) => {
      const token = (server as RunningServer).authTokenService.getToken();
      const ws = new WebSocket(wsUrl, [`kimi-code.bearer.${token}`]);
      const closed = new Promise<void>((res) => ws.on('close', () => res()));
      ws.once('message', () => resolve({ ws, closed }));
      ws.once('error', reject);
    });
  }

  async function waitForSize(target: number, timeoutMs = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (server?.connectionRegistry.size() === target) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`registry size ${target} not observed within ${timeoutMs}ms`);
  }

  it('returns an empty list when no clients are attached', async () => {
    const connections = await listConnections();
    expect(connections).toEqual([]);
  });

  it('lists a raw connection without hello', async () => {
    const { ws, closed } = await openRaw();
    await waitForSize(1);

    const connections = await listConnections();
    expect(connections).toHaveLength(1);
    const c = connections[0]!;
    expect(c.id).toMatch(/^conn_/);
    expect(c.has_client_hello).toBe(false);
    expect(c.subscriptions).toEqual([]);
    expect(c.connected_at).toMatch(/Z$/);
    expect(typeof c.remote_address).toBe('string');
    expect((c.remote_address ?? '').length).toBeGreaterThan(0);

    ws.close();
    await closed;
  });

  it('reflects hello and session-scoped listen subscriptions', async () => {
    const sessionId = await createSession(home as string);
    const client = new WsClient({
      url: wsUrl,
      token: (server as RunningServer).authTokenService.getToken(),
    });
    try {
      // A successful call guarantees the `hello` handshake completed.
      await client.call('core', 'sessionIndex', 'list', {});
      await waitForSize(1);

      const { cancel } = client.listen('session', 'interactions', { sessionId });
      // Let the `listen` register server-side.
      await new Promise((r) => setTimeout(r, 50));

      let connections = await listConnections();
      expect(connections).toHaveLength(1);
      const c = connections[0]!;
      expect(c.has_client_hello).toBe(true);
      expect(c.subscriptions).toContain(sessionId);

      cancel();
      await new Promise((r) => setTimeout(r, 50));
      connections = await listConnections();
      expect(connections[0]!.subscriptions).not.toContain(sessionId);
    } finally {
      client.close();
    }
  });

  it('removes the connection after the socket closes', async () => {
    const client = new WsClient({
      url: wsUrl,
      token: (server as RunningServer).authTokenService.getToken(),
    });
    await client.call('core', 'sessionIndex', 'list', {});
    await waitForSize(1);

    client.close();
    await waitForSize(0);

    const connections = await listConnections();
    expect(connections).toEqual([]);
  });
});
