import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { type RunningServer, startServer } from '../src/start';
import { WS_BEARER_PROTOCOL_PREFIX } from '../src/transport/ws/bearerProtocol';

function openWs(url: string, protocols: string | string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
  });
}

describe('server-v2 WS bearer subprotocol', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let wsUrl: string;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ws-bearer-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    wsUrl = `ws://127.0.0.1:${server.port}/api/v1/ws`;
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      ws.close();
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

  it('accepts a valid bearer subprotocol', async () => {
    const token = server?.authTokenService.getToken() ?? '';
    const ws = await openWs(wsUrl, `${WS_BEARER_PROTOCOL_PREFIX}${token}`);
    sockets.push(ws);
    expect(ws.protocol).toBe(`${WS_BEARER_PROTOCOL_PREFIX}${token}`);
  });

  it('rejects an invalid bearer subprotocol', async () => {
    await expect(openWs(wsUrl, `${WS_BEARER_PROTOCOL_PREFIX}wrong-token`)).rejects.toThrow();
  });
});
