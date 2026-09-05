import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { WS_BEARER_PROTOCOL_PREFIX } from '../src/transport/ws/bearerProtocol';
import { sharedServer } from './helpers/sharedServer';

function openWs(url: string, protocols: string | string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.once('open', () => resolve(ws));
    ws.once('error', (err) => reject(err));
  });
}

describe('server-v2 WS bearer subprotocol', () => {
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      ws.close();
    }
  });

  it('accepts a valid bearer subprotocol', async () => {
    const token = sharedServer().token;
    const wsUrl = `${sharedServer().base.replace(/^http/, 'ws')}/api/v1/ws`;
    const ws = await openWs(wsUrl, `${WS_BEARER_PROTOCOL_PREFIX}${token}`);
    sockets.push(ws);
    expect(ws.protocol).toBe(`${WS_BEARER_PROTOCOL_PREFIX}${token}`);
  });

  it('rejects an invalid bearer subprotocol', async () => {
    const wsUrl = `${sharedServer().base.replace(/^http/, 'ws')}/api/v1/ws`;
    await expect(openWs(wsUrl, `${WS_BEARER_PROTOCOL_PREFIX}wrong-token`)).rejects.toThrow();
  });
});
