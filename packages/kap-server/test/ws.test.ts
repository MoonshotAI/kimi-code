import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ISessionIndex, ISessionMetadata } from '@moonshot-ai/agent-core-v2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { RpcWsError, WsClient } from '../src/transport/ws/wsClient';
import { authHeaders } from './helpers/auth';

interface Envelope<T> {
  code: number;
  data: T;
}

interface SessionMetaWire {
  id: string;
  title?: string;
  archived: boolean;
}

describe('server-v2 /api/v2/ws', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let wsUrl: string;
  let token: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ws-'));
    server = await startServer({ host: '127.0.0.1', port: 0, homeDir: home, logLevel: 'silent' });
    token = server.authTokenService.getToken();
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

  it('performs a core call over WS', async () => {
    const client = new WsClient({ url: wsUrl, token });
    const page = await client.call<{ items: unknown[] }>('core', String(ISessionIndex), 'list', {});
    expect(Array.isArray(page.items)).toBe(true);
    client.close();
  });

  it('performs a session call over WS', async () => {
    const id = await createSession(home as string);
    const client = new WsClient({ url: wsUrl, token });
    const meta = await client.call<SessionMetaWire>('session', String(ISessionMetadata), 'read', undefined, {
      sessionId: id,
    });
    expect(meta.id).toBe(id);
    client.close();
  });

  it('returns an error for an unknown action', async () => {
    const client = new WsClient({ url: wsUrl, token });
    await expect(client.call('core', String(ISessionIndex), 'nope')).rejects.toMatchObject({
      code: 40001,
    });
    client.close();
  });

  it('streams core events via listen', async () => {
    const id = await createSession(home as string);
    const client = new WsClient({ url: wsUrl, token });
    const { iterator, cancel } = client.listen<{ type: string; payload: unknown }>(
      'core',
      'events',
    );

    // Ensure the subscription is registered before publishing.
    await new Promise((r) => setTimeout(r, 50));

    await fetch(`${base}/api/v1/sessions/${id}:archive`, {
      method: 'POST',
      headers: authHeaders(server as RunningServer),
    } as never);

    const iter = iterator[Symbol.asyncIterator]();
    const next = await Promise.race([
      iter.next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no event')), 2000)),
    ]);
    expect(next.done).toBe(false);
    expect(next.value).toMatchObject({
      type: 'event.session.archived',
      payload: { sessionId: id },
    });
    cancel();
    client.close();
  });

  it('streams a Service Event resolved by onUpperCase member name', async () => {
    const id = await createSession(home as string);
    const client = new WsClient({ url: wsUrl, token });
    const { iterator, cancel } = client.listen<{ title?: string }>(
      'session',
      'onDidChangeMetadata',
      { sessionId: id, service: String(ISessionMetadata) },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    await client.call('session', String(ISessionMetadata), 'setTitle', ['changed'], {
      sessionId: id,
    });
    const next = await Promise.race([
      iterator[Symbol.asyncIterator]().next(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no event')), 2000)),
    ]);
    expect(next.value).toMatchObject({ changed: expect.arrayContaining(['title']) });
    cancel();
    client.close();
  });

  it('cancels a subscription', async () => {
    const client = new WsClient({ url: wsUrl, token });
    const { iterator, cancel } = client.listen('core', 'events');
    await new Promise((r) => setTimeout(r, 50));
    cancel();
    const iter = iterator[Symbol.asyncIterator]();
    const next = await iter.next();
    expect(next.done).toBe(true);
    client.close();
  });

  it('rejects pending calls on close', async () => {
    const client = new WsClient({ url: wsUrl, token });
    const pending = client.call('core', String(ISessionIndex), 'list', {});
    client.close();
    await expect(pending).rejects.toThrow();
  });
});

describe('server-v2 /api/v2/ws auth', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let wsUrl: string;
  const token = 'ws-secret';

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-ws-auth-'));
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      rpcToken: token,
    });
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

  it('accepts a call with the correct token', async () => {
    const client = new WsClient({ url: wsUrl, token });
    const page = await client.call<{ items: unknown[] }>('core', String(ISessionIndex), 'list', {});
    expect(Array.isArray(page.items)).toBe(true);
    client.close();
  });

  it('rejects a wrong token', async () => {
    const client = new WsClient({ url: wsUrl, token: 'wrong' });
    await expect(client.call('core', String(ISessionIndex), 'list', {})).rejects.toThrow();
    client.close();
  });
});
