import { describe, expect, it, vi } from 'vitest';

import { createKlient } from '../src/transports/http/index.js';
import type { WsLike, WsLikeCtor } from '../src/transports/ws/wsSocket.js';
import { KlientValidationError } from '../src/core/validation.js';

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type Listener = (event: never) => void;

/** Minimal fake WS endpoint: records frames and lets the test push events. */
class FakeWsServer {
  readonly frames: Record<string, unknown>[] = [];
  lastUrl = '';
  lastProtocols: string[] | undefined;
  private socket: FakeSocket | undefined;

  attach(socket: FakeSocket): void {
    this.socket = socket;
    queueMicrotask(() => {
      socket.readyState = FakeSocket.OPEN;
      socket.fire('open');
      this.send({ type: 'ready' });
    });
  }

  receive(raw: string): void {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.frames.push(frame);
    if (frame['type'] === 'listen') {
      this.send({ type: 'listen_result', id: frame['id'] });
    }
  }

  pushEvent(data: unknown): void {
    const listen = this.frames.find((frame) => frame['type'] === 'listen')!;
    this.send({ type: 'event', id: listen['id'], data });
  }

  private send(frame: Record<string, unknown>): void {
    this.socket?.deliver(frame);
  }
}

class FakeSocket implements WsLike {
  static readonly OPEN = 1;
  readyState = 0;
  private readonly handlers = new Map<string, Set<Listener>>();

  constructor(
    private readonly server: FakeWsServer,
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
}

function fakeCtor(server: FakeWsServer): WsLikeCtor {
  class BoundFakeSocket extends FakeSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(server, url, protocols);
    }
  }
  return BoundFakeSocket as unknown as WsLikeCtor;
}

function jsonResponse(envelope: Record<string, unknown>): Response {
  return { json: () => Promise.resolve(envelope) } as unknown as Response;
}

function okEnvelope(data: unknown): Record<string, unknown> {
  return { code: 0, msg: '', data, request_id: 'r1' };
}

describe('http transport', () => {
  it('POSTs the args tuple to the scope service/method URL with the bearer header', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          okEnvelope({
            id: 's1',
            workspaceId: 'w1',
            createdAt: 1,
            updatedAt: 2,
            archived: false,
          }),
        ),
      ),
    );
    const klient = createKlient({
      url: 'http://127.0.0.1:58627/',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const summary = await klient.global.sessions.get('s1');
    expect(summary?.id).toBe('s1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:58627/api/v2/sessionIndex/get');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual(['s1']);
    await klient.close();
  });

  it('omits the body for zero-arg calls', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({}))));
    const klient = createKlient({
      url: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await klient.global.config.getAll();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeUndefined();
    await klient.close();
  });

  it('unwraps a non-zero envelope code into RPCError', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ code: 40001, msg: 'workspace not found', data: null, request_id: 'r' })),
    );
    const klient = createKlient({
      url: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(klient.global.workspaces.get('nope')).rejects.toMatchObject({
      name: 'RPCError',
      code: 40001,
    });
    await klient.close();
  });

  it('rejects drifted output with KlientValidationError', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({ id: 42 }))));
    const klient = createKlient({
      url: 'http://127.0.0.1:58627',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(klient.global.sessions.get('s1')).rejects.toBeInstanceOf(KlientValidationError);
    await klient.close();
  });

  it('lazily opens one WS for events, sends emitter listen frames, and validates payloads', async () => {
    const server = new FakeWsServer();
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(okEnvelope({}))));
    const klient = createKlient({
      url: 'http://127.0.0.1:58627',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
      WebSocketImpl: fakeCtor(server),
    });

    const seen: unknown[] = [];
    const errors: Error[] = [];
    klient.events.onError((error) => {
        errors.push(error);
      });
    klient.events.on('providers.changed', (event) => seen.push(event));
    await tick(10);

    expect(server.lastUrl).toBe('ws://127.0.0.1:58627/api/v2/ws');
    expect(server.lastProtocols).toEqual(['kimi-code.bearer.tok']);
    const listen = server.frames.find((frame) => frame['type'] === 'listen')!;
    expect(listen).toMatchObject({
      scope: 'core',
      service: 'providerService',
      event: 'onDidChangeProviders',
    });

    server.pushEvent({ added: ['p1'], removed: [], changed: [] });
    server.pushEvent({ added: 1 });
    await tick(10);
    expect(seen).toEqual([{ added: ['p1'], removed: [], changed: [] }]);
    expect(errors).toHaveLength(1);

    await klient.close();
  });
});
