/**
 * server-v2 `--dangerous-bypass-auth` (`disableAuth`) wiring.
 *
 * When the operator opts out of the bearer-token gate, every REST and
 * WebSocket route accepts unauthenticated requests, and `/api/v1/meta`
 * advertises `dangerous_bypass_auth: true` so the web UI can connect without a
 * token. The default (hardened) boot keeps the gate closed and reports
 * `dangerous_bypass_auth: false`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
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

/** Resolve when the socket opens and the server's first frame arrives. */
function openConn(url: string): Promise<{ ws: WebSocket; firstFrame: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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

describe('server-v2 disableAuth (--dangerous-bypass-auth)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  const sockets: WebSocket[] = [];

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

  async function boot(disableAuth?: boolean): Promise<{ base: string; port: number }> {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-disable-auth-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
      disableAuth,
    });
    return { base: `http://127.0.0.1:${server.port}`, port: server.port };
  }

  it('disableAuth:true lets REST through without a token and advertises it in /meta', async () => {
    const { base } = await boot(true);

    const meta = await fetch(`${base}/api/v1/meta`); // no Authorization header
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      code: number;
      data: { dangerous_bypass_auth: boolean };
    };
    expect(metaBody.code).toBe(0);
    expect(metaBody.data.dangerous_bypass_auth).toBe(true);

    // A normally-protected route is also open without a credential.
    const auth = await fetch(`${base}/api/v1/auth`);
    expect(auth.status).toBe(200);
  });

  it('disableAuth:true lets WebSocket upgrades through without a token', async () => {
    const { port } = await boot(true);

    const v1 = await openConn(`ws://127.0.0.1:${port}/api/v1/ws`);
    sockets.push(v1.ws);
    expect(v1.firstFrame).toMatchObject({ type: 'server_hello' });

    const v2 = await openConn(`ws://127.0.0.1:${port}/api/v2/ws`);
    sockets.push(v2.ws);
    expect(v2.firstFrame).toMatchObject({ type: 'ready' });
  });

  it('default boot keeps the gate closed and reports dangerous_bypass_auth: false', async () => {
    const { base } = await boot(undefined);

    const unauthed = await fetch(`${base}/api/v1/meta`); // no token
    expect(unauthed.status).toBe(401);

    const meta = await fetch(`${base}/api/v1/meta`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      code: number;
      data: { dangerous_bypass_auth: boolean };
    };
    expect(metaBody.data.dangerous_bypass_auth).toBe(false);
  });
});
