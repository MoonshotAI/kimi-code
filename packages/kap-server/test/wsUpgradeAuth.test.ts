import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IModelCatalog } from '@moonshot-ai/agent-core-v2';
import { createActor, setup } from '@moonshot-ai/agent-core-v2/human/xstate2';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';

import { startServer } from '../src/start';
import { fakeModelCatalog } from './helpers/fakeModelCatalog';
import { fixedTokenAuth } from './helpers/fixedAuth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { sharedServer } from './helpers/sharedServer';

function rawToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFrame(
  received: Record<string, unknown>[],
  match: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  for (;;) {
    const found = received.find(match);
    if (found !== undefined) return found;
    if (Date.now() - start > timeoutMs) throw new Error('no matching frame within timeout');
    await sleep(20);
  }
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

  function v3Url(): string {
    return `${sharedServer().base.replace(/^http/, 'ws')}/api/v3/ws`;
  }

  function token(): string {
    return sharedServer().token;
  }

  describe('/api/v3/ws', () => {
    const firstType = 'hello';
    const url = (): string => v3Url();

    it('accepts a valid bearer subprotocol and echoes it', async () => {
      const { ws, firstFrame } = await openConn(url(), {
        protocols: [`kimi-code.bearer.${token()}`],
      });
      sockets.push(ws);
      expect(ws.protocol).toBe(`kimi-code.bearer.${token()}`);
      expect(firstFrame).toMatchObject({ type: firstType });
    });

    it('rejects a wrong bearer token', async () => {
      await expectRejected(url(), { protocols: ['kimi-code.bearer.wrong'] });
    });

    it('rejects a connection with no token', async () => {
      await expectRejected(url());
    });
  });

  describe('/api/v1/debug/ws', () => {
    it('streams xstate inspection envelopes to an authorized client only after subscribe', async () => {
      const home = await mkdtemp(join(tmpdir(), 'kimi-kap-debug-ws-'));
      const server = await startServer({
        hostIdentity: TEST_HOST_IDENTITY,
        host: '127.0.0.1',
        port: 0,
        homeDir: home,
        logLevel: 'silent',
        authTokenService: fixedTokenAuth(),
        seeds: [[IModelCatalog, fakeModelCatalog()]],
      });
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/v1/debug/ws`, {
        headers: { Authorization: 'Bearer test-token' },
      });
      sockets.push(ws);
      try {
        const received: Record<string, unknown>[] = [];
        ws.on('message', (data) => {
          received.push(JSON.parse(rawToString(data)) as Record<string, unknown>);
        });
        await new Promise<void>((resolve) => ws.once('open', resolve));
        const probe = (): void => {
          const machine = setup({}).createMachine({
            id: 'debugWsProbe',
            initial: 'idle',
            states: { idle: { on: { 'debug.probe': 'done' } }, done: {} },
          });
          const actor = createActor(machine);
          actor.start();
          actor.send({ type: 'debug.probe' });
        };
        probe();
        await sleep(200);
        expect(received).toHaveLength(0);
        ws.send(JSON.stringify({ type: 'subscribe' }));
        await sleep(100);
        probe();
        const envelope = await waitForFrame(
          received,
          (frame) => frame['eventType'] === 'debug.probe',
        );
        expect(envelope['type']).toBe('@xstate.event');
        expect(envelope['logicId']).toBe('debugWsProbe');
        expect(typeof envelope['actorId']).toBe('string');
        expect(typeof envelope['timestamp']).toBe('number');
        ws.send(JSON.stringify({ type: 'unsubscribe' }));
        await sleep(100);
        received.length = 0;
        probe();
        await sleep(200);
        expect(received).toHaveLength(0);
      } finally {
        await server.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  });

  it('rejects upgrades to a non-WS path', async () => {
    const badUrl = `${v3Url().replace('/api/v3/ws', '/api/v1/other')}`;
    await expectRejected(badUrl, { protocols: [`kimi-code.bearer.${token()}`] });
    const goneUrl = `${v3Url().replace('/api/v3/ws', '/api/v1/ws')}`;
    await expectRejected(goneUrl, { protocols: [`kimi-code.bearer.${token()}`] });
  });
});
