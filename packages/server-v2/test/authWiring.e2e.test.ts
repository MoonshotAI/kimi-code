/**
 * Production auth wiring end-to-end (port of v1 `auth-wiring.e2e.test.ts`).
 *
 * Boots `startServer` with NO auth override so the REAL persistent-token auth
 * is built (`<homeDir>/server.token`, mode 0600). The token is read back from
 * disk — exactly what the CLI does — and exercised against a gated HTTP route
 * and the `/api/v1/ws` upgrade path.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { type RunningServer, startServer } from '../src/start';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function openConn(url: string, protocols: string[]): Promise<{ ws: WebSocket; firstFrame: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
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

function expectRejected(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
        // ignore
      }
      if (err === undefined) resolve();
      else reject(err);
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

describe('production auth wiring', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-auth-wiring-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    base = `http://127.0.0.1:${server.port}`;
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

  it.skipIf(process.platform === 'win32')('writes a 0600 token file at boot and keeps it on close', async () => {
    const p = join(home as string, 'server.token');
    const info = await stat(p);
    expect(info.mode & 0o777).toBe(0o600);
    const token = (await readFile(p, 'utf8')).trim();
    expect(token.length).toBeGreaterThan(0);

    await (server as RunningServer).close();
    server = undefined;
    // Persistent token: the file survives shutdown so the next start reuses it.
    const after = await stat(p);
    expect(after.mode & 0o777).toBe(0o600);
  });

  it('gates HTTP: 200 with the token, 401 without', async () => {
    const token = (await readFile(join(home as string, 'server.token'), 'utf8')).trim();

    const ok = await fetch(`${base}/openapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);

    const bad = await fetch(`${base}/openapi.json`);
    expect(bad.status).toBe(401);
    const body = (await bad.json()) as { code: number };
    expect(body.code).toBe(40101);
  });

  it('gates /asyncapi.json: 200 with the token, 401 without', async () => {
    const token = (await readFile(join(home as string, 'server.token'), 'utf8')).trim();

    const ok = await fetch(`${base}/asyncapi.json`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(ok.status).toBe(200);
    const doc = (await ok.json()) as { asyncapi?: string };
    expect(doc.asyncapi).toBeDefined();

    const bad = await fetch(`${base}/asyncapi.json`);
    expect(bad.status).toBe(401);
  });

  it('gates WS: server_hello with the token, rejected without', async () => {
    const token = (await readFile(join(home as string, 'server.token'), 'utf8')).trim();
    const wsUrl = `ws://127.0.0.1:${(server as RunningServer).port}/api/v1/ws`;

    const { ws, firstFrame } = await openConn(wsUrl, [`kimi-code.bearer.${token}`]);
    sockets.push(ws);
    expect(firstFrame).toMatchObject({ type: 'server_hello' });

    await expectRejected(wsUrl);
  });
});
