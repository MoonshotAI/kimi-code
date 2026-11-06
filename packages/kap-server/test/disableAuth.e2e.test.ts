import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { fixedTokenAuth } from './helpers/fixedAuth';

const TOKEN = 'test-token';

function openConn(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

describe('server-v2 disableAuth (--dangerous-bypass-auth)', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  const sockets: WebSocket[] = [];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-disable-auth-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
      disableAuth: true,
    });
  });

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
  });

  afterAll(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true });
      home = undefined;
    }
  });

  it('disableAuth:true lets REST through without a token and advertises it in /meta', async () => {
    const base = `http://127.0.0.1:${server!.port}`;

    const meta = await fetch(`${base}/api/v1/meta`);
    expect(meta.status).toBe(200);
    const metaBody = (await meta.json()) as {
      code: number;
      data: { dangerous_bypass_auth: boolean };
    };
    expect(metaBody.code).toBe(0);
    expect(metaBody.data.dangerous_bypass_auth).toBe(true);

    const auth = await fetch(`${base}/api/v1/auth`);
    expect(auth.status).toBe(200);
  });

  it('disableAuth:true lets WebSocket upgrades through without a token', async () => {
    const ws = await openConn(`ws://127.0.0.1:${server!.port}/api/v1/ws`);
    sockets.push(ws);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it('default boot keeps the gate closed and reports dangerous_bypass_auth: false', async () => {
    const altHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-disable-auth-'));
    const alt = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: altHome,
      logLevel: 'silent',
      authTokenService: fixedTokenAuth(TOKEN),
      disableAuth: undefined,
    });
    try {
      const base = `http://127.0.0.1:${alt.port}`;

      const unauthed = await fetch(`${base}/api/v1/meta`);
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
    } finally {
      await alt.close();
      await rm(altHome, { recursive: true, force: true });
    }
  });
});
