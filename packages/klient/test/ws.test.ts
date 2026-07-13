import { describe, expect, it } from 'vitest';

import { ISessionIndex } from '@moonshot-ai/agent-core-v2/app/sessionIndex/sessionIndex';
import { ISessionMetadata } from '@moonshot-ai/agent-core-v2/session/sessionMetadata/sessionMetadata';

import { Klient } from '../src/client.js';
import { WsKlient } from '../src/wsKlient.js';
import type { WsLike, WsLikeCtor, WsSocketState } from '../src/wsSocket.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Listener = (event: never) => void;

/**
 * In-memory emulation of the kap-server `/api/v2/ws` endpoint: answers `call`
 * with an echo `result`, `boom` with an `error`, pushes `event`s to active
 * `listen`s, and can drop the socket to exercise reconnect.
 */
class FakeServer {
  readonly frames: Record<string, unknown>[] = [];
  readonly listens = new Set<string>();
  pongs = 0;
  helloCount = 0;
  lastUrl = '';
  lastProtocols: string[] | undefined;
  private socket: FakeClientSocket | undefined;

  attach(socket: FakeClientSocket): void {
    this.socket = socket;
    queueMicrotask(() => {
      socket.readyState = FakeClientSocket.OPEN;
      socket.fire('open');
      this.send({ type: 'ready', heartbeatMs: 30_000 });
    });
  }

  receive(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.frames.push(frame);
    switch (frame['type']) {
      case 'hello':
        this.helloCount += 1;
        return;
      case 'call':
        if (frame['method'] === 'boom') {
          this.send({ type: 'error', id: frame['id'], code: 40001, msg: 'boom' });
        } else {
          this.send({
            type: 'result',
            id: frame['id'],
            data: {
              scope: frame['scope'],
              service: frame['service'],
              method: frame['method'],
              arg: frame['arg'] ?? null,
              sessionId: frame['sessionId'] ?? null,
              agentId: frame['agentId'] ?? null,
            },
          });
        }
        return;
      case 'listen':
        this.listens.add(frame['id'] as string);
        this.send({ type: 'listen_result', id: frame['id'] });
        return;
      case 'unlisten':
        this.listens.delete(frame['id'] as string);
        return;
      case 'pong':
        this.pongs += 1;
        return;
    }
  }

  pushEvent(id: string, data: unknown, eventId?: string): void {
    this.send({ type: 'event', id, eventId, data });
  }

  pushError(id: string, msg: string): void {
    this.send({ type: 'error', id, code: 40001, msg });
  }

  cancelEvent(id: string, eventId: string): void {
    this.send({ type: 'event_cancel', id, eventId });
  }

  ping(): void {
    this.send({ type: 'ping' });
  }

  drop(): void {
    this.socket?.dropFromServer();
  }

  private send(frame: Record<string, unknown>): void {
    this.socket?.deliver(frame);
  }
}

class FakeClientSocket implements WsLike {
  static readonly OPEN = 1;
  readyState = 0;
  private readonly handlers = new Map<string, Set<Listener>>();

  constructor(
    private readonly server: FakeServer,
    url: string,
    protocols?: string | string[],
  ) {
    server.lastUrl = url;
    server.lastProtocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : undefined;
    server.attach(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.handlers.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.handlers.set(type, set);
  }

  send(data: string): void {
    this.server.receive(data);
  }

  close(): void {
    this.readyState = 3;
    this.fire('close');
  }

  fire(type: string): void {
    for (const handler of this.handlers.get(type) ?? []) handler(undefined as never);
  }

  deliver(frame: Record<string, unknown>): void {
    queueMicrotask(() => {
      for (const handler of this.handlers.get('message') ?? []) {
        handler({ data: JSON.stringify(frame) } as never);
      }
    });
  }

  dropFromServer(): void {
    this.readyState = 3;
    this.fire('close');
  }
}

function fakeCtor(server: FakeServer): WsLikeCtor {
  class BoundFakeSocket extends FakeClientSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(server, url, protocols);
    }
  }
  return BoundFakeSocket as unknown as WsLikeCtor;
}

async function openKlient(server: FakeServer, opts: { token?: string } = {}): Promise<WsKlient> {
  const ws = new WsKlient({
    url: 'http://127.0.0.1:58627',
    token: opts.token,
    WebSocketImpl: fakeCtor(server),
    reconnectDelayMs: 10,
  });
  await tick(5);
  return ws;
}

describe('WsKlient', () => {
  it('routes calls by scope / service / method with scope ids', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);

    const core = await ws.core(ISessionIndex).list({ workspaceId: 'w1' });
    const session = await ws.session('s1').service(ISessionMetadata).read();
    const agent = await ws.session('s1').agent('a1').service(ISessionMetadata).read();

    expect(core).toMatchObject({ scope: 'core', service: 'sessionIndex', method: 'list' });
    expect(session).toMatchObject({ scope: 'session', service: 'sessionMetadata', sessionId: 's1' });
    expect(agent).toMatchObject({
      scope: 'agent',
      service: 'sessionMetadata',
      sessionId: 's1',
      agentId: 'a1',
    });
    ws.close();
  });

  it('rejects calls with RPCError on error frames', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    const meta = ws.session('s1').service(ISessionMetadata) as unknown as {
      boom(): Promise<unknown>;
    };
    await expect(meta.boom()).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    ws.close();
  });

  it('delivers events to listen handlers and sends unlisten on dispose', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    const seen: unknown[] = [];
    const sub = ws.session('s1').listen('interactions', (data) => seen.push(data));
    await tick(5);
    const listenId = [...server.listens][0]!;
    server.pushEvent(listenId, [{ id: 'a1' }]);
    await tick(5);
    expect(seen).toEqual([[{ id: 'a1' }]]);

    sub.dispose();
    expect(server.listens.size).toBe(0);
    ws.close();
  });

  it('proxies Service events with one remote subscription for first/last listeners', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    const service = ws.session('s1').service(ISessionMetadata);
    const first: unknown[] = [];
    const second: unknown[] = [];
    const a = service.onDidChangeMetadata((event) => first.push(event));
    const b = service.onDidChangeMetadata((event) => second.push(event));
    await tick(5);

    expect(server.listens.size).toBe(1);
    const listen = server.frames.find((frame) => frame['type'] === 'listen')!;
    expect(listen).toMatchObject({
      scope: 'session',
      service: 'sessionMetadata',
      event: 'onDidChangeMetadata',
      sessionId: 's1',
    });
    server.pushEvent(listen['id'] as string, { title: 'updated' });
    await tick(5);
    expect(first).toEqual([{ title: 'updated' }]);
    expect(second).toEqual([{ title: 'updated' }]);

    a.dispose();
    expect(server.listens.size).toBe(1);
    b.dispose();
    expect(server.listens.size).toBe(0);
    ws.close();
  });

  it('reports asynchronous subscription errors and terminates the subscription', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    const errors: string[] = [];
    ws.onDidListenError((event) => errors.push(event.error.message));
    const service = ws.session('s1').service(ISessionMetadata);
    service.onDidChangeMetadata(() => undefined);
    await tick(5);
    const id = [...server.listens][0]!;
    server.pushError(id, 'payload is not serializable');
    await tick(5);
    expect(errors).toEqual(['payload is not serializable']);
    ws.close();
  });

  it('waits for onWill listener work and aborts it on server cancel', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    const service = ws.session('s1').service(ISessionMetadata) as unknown as {
      onWillSave(listener: (event: { signal: AbortSignal; waitUntil(p: Promise<unknown>): void }) => void): {
        dispose(): void;
      };
    };
    let aborted = false;
    service.onWillSave((event) => {
      event.signal.addEventListener('abort', () => {
        aborted = true;
      });
      event.waitUntil(new Promise(() => undefined));
    });
    await tick(5);
    const id = [...server.listens][0]!;
    server.pushEvent(id, {}, 'e1');
    await tick(5);
    expect(server.frames.some((frame) => frame['type'] === 'event_result')).toBe(false);
    server.cancelEvent(id, 'e1');
    await tick(5);
    expect(aborted).toBe(true);
    expect(server.frames.some((frame) => frame['type'] === 'event_result')).toBe(false);
    ws.close();
  });

  it('answers heartbeat pings with pong', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    server.ping();
    await tick(5);
    expect(server.pongs).toBe(1);
    ws.close();
  });

  it('reconnects after a drop: calls reject, listens re-subscribe, state is observable', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    const states: WsSocketState[] = [];
    ws.onDidChangeState((s) => states.push(s));
    const seen: unknown[] = [];
    ws.session('s1').agent('a1').listen('events', (data) => seen.push(data));
    await tick(5);

    const inFlight = ws.core(ISessionIndex).countActive('w1');
    server.drop();
    await expect(inFlight).rejects.toThrow('ws closed');
    expect(ws.state).toBe('connecting');

    await tick(50); // backoff 10ms → reconnect
    expect(ws.state).toBe('open');
    expect(server.helloCount).toBe(2);
    expect(server.listens.size).toBe(1);

    const listenId = [...server.listens][0]!;
    server.pushEvent(listenId, { type: 'turn.started' });
    await tick(5);
    expect(seen).toEqual([{ type: 'turn.started' }]);

    const data = await ws.core(ISessionIndex).countActive('w1');
    expect(data).toMatchObject({ method: 'countActive' });
    expect(states).toContain('connecting');
    ws.close();
    expect(ws.state).toBe('closed');
  });

  it('Klient.ws() is a lazy singleton deriving the ws URL and bearer subprotocol', async () => {
    const server = new FakeServer();
    const client = new Klient({
      url: 'http://127.0.0.1:58627',
      token: 'tok',
      WebSocketImpl: fakeCtor(server),
    });
    const ws = client.ws();
    expect(client.ws()).toBe(ws);
    await tick(5);
    expect(server.lastUrl).toBe('ws://127.0.0.1:58627/api/v2/ws');
    expect(server.lastProtocols).toEqual(['kimi-code.bearer.tok']);
    const data = await ws.core(ISessionIndex).list({});
    expect(data).toMatchObject({ service: 'sessionIndex' });
    ws.close();
  });

  it('rejects calls made after close', async () => {
    const server = new FakeServer();
    const ws = await openKlient(server);
    ws.close();
    await expect(ws.core(ISessionIndex).list({})).rejects.toThrow('ws closed');
  });

  it('Klient.ws() recreates a fresh socket after the previous one was closed', async () => {
    const server = new FakeServer();
    const client = new Klient({
      url: 'http://127.0.0.1:58627',
      WebSocketImpl: fakeCtor(server),
    });
    const first = client.ws();
    await tick(5);
    first.close();
    const second = client.ws();
    expect(second).not.toBe(first);
    await tick(5);
    expect(second.state).toBe('open');
    const data = await second.core(ISessionIndex).list({});
    expect(data).toMatchObject({ service: 'sessionIndex' });
    second.close();
  });
});
