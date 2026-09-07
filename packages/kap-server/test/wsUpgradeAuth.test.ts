import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { sharedServer } from './helpers/sharedServer';

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

function expectRejected(url: string, opts?: ConnectOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts?.protocols, { headers: opts?.headers });
    const done = (err?: Error): void => {
      clearTimeout(t);
      ws.removeAllListeners();
      try {
        ws.terminate();
      } catch {
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
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const ws of sockets.splice(0)) {
      try {
        ws.close();
      } catch {
      }
    }
  });

  function v1Url(): string {
    return `${sharedServer().base.replace(/^http/, 'ws')}/api/v1/ws`;
  }

  function token(): string {
    return sharedServer().token;
  }

  describe('/api/v1/ws', () => {
    const firstType = 'server_hello';
    const url = (): string => v1Url();

    it('accepts a valid bearer subprotocol and echoes it', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        protocols: [`kimi-code.bearer.${token()}`],
      });
      sockets.push(ws);
      expect(ws.protocol).toBe(`kimi-code.bearer.${token()}`);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('accepts a valid Authorization bearer header', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        headers: { Authorization: `Bearer ${token()}` },
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
    const badUrl = `${v1Url().replace('/api/v1/ws', '/api/v1/other')}`;
    await expectRejected(badUrl, { protocols: [`kimi-code.bearer.${token()}`] });
  });
});
