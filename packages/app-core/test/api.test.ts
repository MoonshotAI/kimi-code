import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonHttpClient } from '../src/api/daemon/http';
import { DaemonEventSocket } from '../src/api/daemon/ws';
import type { CredentialStore, Tracer } from '../src/contracts';

const identity = {
  clientId: 'web_t',
  clientName: 't',
  clientVersion: '0',
  clientUiMode: 'web',
};

function makeClient(opts: {
  tracer?: Tracer;
  credentialStore?: CredentialStore;
  allowCodes?: number[];
}) {
  return new DaemonHttpClient({
    origin: 'http://test.local',
    identity,
    tracer: opts.tracer,
    credentialStore: opts.credentialStore,
  });
}

class FakeWebSocket {
  static last: FakeWebSocket | undefined;
  static OPEN = 1;
  url: string;
  protocols: string[] | undefined;
  readyState = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: unknown[] = [];
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
}

const noopHandlers = {
  onWireEvent: () => {},
  onInteraction: () => {},
  onInteractionsReset: () => {},
  onConnectionState: () => {},
  onError: () => {},
};

describe('DaemonHttpClient injection', () => {
  it('uses injected credentialStore for Authorization and tracer.restRequest', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const credentialStore: CredentialStore = {
      getToken: () => 'tok_abc',
      markAuthRequired: vi.fn(),
    };
    const tracer: Tracer = { restRequest: vi.fn(), restFailure: vi.fn() };
    const client = makeClient({ tracer, credentialStore });

    await client.get('/api/v1/meta');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok_abc');
    expect(tracer.restRequest).toHaveBeenCalledOnce();
  });

  it('traces request and response headers with the bearer token masked', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 0 }), {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    })));
    const restRequest = vi.fn();
    const restResponse = vi.fn();
    const client = makeClient({ tracer: { restRequest, restResponse }, credentialStore: { getToken: () => 'tok_abc' } });

    await client.get('/api/v1/meta');

    expect(restRequest).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer ***', 'X-Request-Id': expect.any(String) }),
    }));
    expect(restResponse).toHaveBeenCalledWith(expect.objectContaining({
      statusText: 'OK',
      headers: expect.objectContaining({ 'content-type': 'application/json' }),
    }));
  });

  it('traces the envelope details of a failed response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 40401,
      msg: 'session not found',
      details: { session_id: 's1' },
    }), { status: 404 })));
    const restResponse = vi.fn();
    const client = makeClient({ tracer: { restResponse } });

    await expect(client.get('/sessions/s1')).rejects.toMatchObject({ code: 40401 });
    expect(restResponse).toHaveBeenCalledWith(expect.objectContaining({ code: 40401, details: { session_id: 's1' } }));
  });

  it('omits Authorization when no credentialStore is provided', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({});

    await client.get('/api/v1/meta');

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('calls credentialStore.markAuthRequired on a 40101 envelope', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 40101, msg: 'unauthorized' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const markAuthRequired = vi.fn();
    const credentialStore: CredentialStore = { getToken: () => 'tok_abc', markAuthRequired };
    const client = makeClient({ credentialStore, allowCodes: [40101] });

    await client.post('/api/v1/sessions', {}, { allowCodes: [40101] }).catch(() => {});

    expect(markAuthRequired).toHaveBeenCalled();
  });
});

describe('DaemonEventSocket injection', () => {
  it('sends the bearer subprotocol from the injected credentialStore', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const credentialStore: CredentialStore = { getToken: () => 'ws_tok' };
    const tracer: Tracer = { wsEvent: vi.fn() };
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
      tracer,
      credentialStore,
    });

    socket.connect();

    expect(FakeWebSocket.last?.protocols).toEqual(['kimi-code.bearer.ws_tok']);
  });

  it('sends nothing when the socket opens', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});

    expect(ws.sent).toEqual([]);
  });

  it('adds agents to a session’s conversation subscription and detaches one', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});
    ws.sent = [];

    socket.subscribeConversation('s1', 'agent-a');
    socket.subscribeConversation('s1', 'agent-b');
    socket.unsubscribeConversation('s1', ['agent-b']);

    expect(ws.sent).toEqual([
      expect.objectContaining({ type: 'subscribe', session_id: 's1', agent_ids: ['agent-a'] }),
      expect.objectContaining({ type: 'subscribe', session_id: 's1', agent_ids: ['agent-a', 'agent-b'] }),
      expect.objectContaining({ type: 'unsubscribe', session_id: 's1', agent_ids: ['agent-b'] }),
    ]);
  });

  it('resends every subscribed agent on reconnect', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: noopHandlers,
    });
    socket.connect();
    let ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});

    socket.subscribeConversation('s1', 'agent-a');
    socket.subscribeConversation('s1', 'agent-b');

    socket.reconnect();
    ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onopen?.({});

    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'subscribe', session_id: 's1', agent_ids: ['agent-a', 'agent-b'] }),
    );
  });

  it('routes agent, usage, goal, todo and queue frames to the agent feed handler', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onAgentFeedFrame = vi.fn();
    const onEvent = vi.fn();
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: { ...noopHandlers, onEvent, onAgentFeedFrame },
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    socket.subscribeConversation('s1', 'main');
    const base = { session_id: 's1', agent_id: 'main', event_created_at: '2026-01-01T00:00:00.000Z' };
    const frames = [
      {
        type: 'agent',
        ...base,
        status: 'running',
        model: 'k2',
        plan_mode: true,
        swarm_mode: false,
        tower_mode: false,
      },
      { type: 'context', ...base, context_tokens: 10, max_context_tokens: 100 },
      { type: 'goal', ...base },
      { type: 'todo', ...base, items: [{ title: 'ship', status: 'pending' }] },
      { type: 'queue', ...base, inputs: [] },
    ];
    for (const frame of frames) ws.onmessage?.({ data: JSON.stringify(frame) });
    ws.onmessage?.({ data: JSON.stringify({ type: 'queue', ...base, agent_id: 'unsubscribed', inputs: [] }) });

    expect(onAgentFeedFrame.mock.calls.map(([frame]) => frame)).toEqual(frames);
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('routes conversation frames of subscribed agents outside the legacy event classifier', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onConversation = vi.fn();
    const onEvent = vi.fn();
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws',
      handlers: { ...noopHandlers, onEvent, onConversation },
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    socket.subscribeConversation('s1', 'agent-a');
    const base = { session_id: 's1', event_created_at: '2026-01-01T00:00:00.000Z' };
    const turns = { type: 'turns', ...base, agent_id: 'agent-a', turns: [], has_more: false };
    const delta = { type: 'item.delta', ...base, agent_id: 'agent-a', turn_id: 't0', item_id: 'i1', field: 'text', delta: 'hi' };
    const updated = { type: 'turn.updated', ...base, agent_id: 'agent-a', turn_id: 't0' };
    const unsubscribed = { type: 'turns', ...base, agent_id: 'agent-b', turns: [], has_more: false };
    const removed = { type: 'turns.removed', ...base, agent_id: 'agent-a', turn_ids: ['t0'] };
    for (const frame of [turns, delta, updated, unsubscribed, removed]) ws.onmessage?.({ data: JSON.stringify(frame) });

    expect(onConversation.mock.calls).toEqual([
      ['s1', 'agent-a', turns],
      ['s1', 'agent-a', delta],
      ['s1', 'agent-a', updated],
      ['s1', 'agent-a', removed],
    ]);
    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe('DaemonHttpClient.getBlob maxBytes', () => {
  it('rejects at the Content-Length header and cancels the body stream', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(16));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-length': String(20 * 1024 * 1024), 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const restResponse = vi.fn();
    const client = makeClient({ tracer: { restResponse } });

    await expect(
      client.getBlob('/fs:content', { path: '/big.log' }, { maxBytes: 10_485_760 }),
    ).rejects.toMatchObject({ name: 'FileTooLargeError', limit: 10_485_760 });
    expect(cancelled).toBe(true);
    expect(restResponse).toHaveBeenCalledOnce();
  });

  it('returns the blob when the Content-Length is within the cap', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'content-length': '3' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({});

    const blob = await client.getBlob('/fs:content', { path: '/small.txt' }, { maxBytes: 10 });
    expect(blob.size).toBe(3);
  });
});

describe('DaemonHttpClient.getBlob error envelopes', () => {
  it('rejects a structured error envelope returned with HTTP 200', async () => {
    let responseRequestId = '';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      responseRequestId = init.headers['X-Request-Id'] as string;
      const body = JSON.stringify({ code: 40409, msg: 'path not found', data: null, request_id: responseRequestId });
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8', 'content-length': String(body.length) },
      }));
    }));
    const client = makeClient({});

    await expect(client.getBlob('/fs:content', { path: '/missing.png' })).rejects.toMatchObject({
      name: 'DaemonApiError',
      code: 40409,
      message: 'path not found',
      requestId: responseRequestId,
    });
    expect(responseRequestId).not.toBe('');
  });

  it('rejects a chunked error envelope without Content-Length', async () => {
    let responseRequestId = '';
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, init) => {
      responseRequestId = init.headers['X-Request-Id'] as string;
      const body = JSON.stringify({ code: 40409, msg: 'path not found', data: null, request_id: responseRequestId });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return Promise.resolve(new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json;charset=utf-8' },
      }));
    }));
    const client = makeClient({});

    await expect(client.getBlob('/fs:content', { path: '/missing.png' })).rejects.toMatchObject({
      name: 'DaemonApiError',
      code: 40409,
      requestId: responseRequestId,
    });
  });

  it('returns a large chunked JSON file without waiting for the clone cancellation', async () => {
    const content = `{"data":"${'x'.repeat(70 * 1024)}"}`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const client = makeClient({});

    const blob = await client.getBlob('/fs:content', { path: '/large.json' });
    expect(blob.size).toBe(content.length);
    expect(await blob.text()).toBe(content);
  });

  it('does not reject ordinary JSON file content', async () => {
    const content = JSON.stringify({ code: 40409, msg: 'domain value', data: null, request_id: 'document' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(content, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));
    const client = makeClient({});

    const blob = await client.getBlob('/fs:content', { path: '/document.json' });
    expect(await blob.text()).toBe(content);
  });
});

function jsonResponse(data: unknown = null): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    headers: { 'content-type': 'application/json' },
  });
}

function streamingResponse(): {
  response: Response;
  finish: (data?: unknown) => void;
  fail: (error: unknown) => void;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
  });
  return {
    response: new Response(stream, { headers: { 'content-type': 'application/json' } }),
    finish(data = null) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify({ code: 0, msg: '', data })));
      controller.close();
    },
    fail(error) { controller.error(error); },
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Response>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function flushRequests(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe('DaemonHttpClient background requests', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('holds two slots through response bodies and admits the remaining requests FIFO', async () => {
    const firstBody = streamingResponse();
    const secondBody = streamingResponse();
    const thirdBody = streamingResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(firstBody.response)
      .mockResolvedValueOnce(secondBody.response)
      .mockResolvedValueOnce(thirdBody.response)
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const tracer = { restRequest: vi.fn(), restResponse: vi.fn(), restFailure: vi.fn() };
    const client = makeClient({ tracer });
    const controller = new AbortController();
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    const third = client.get('/third', undefined, { background: true });
    const cancelled = client.get('/cancelled', undefined, { background: true, signal: controller.signal });
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const fifth = client.get('/fifth', undefined, { background: true });
    await flushRequests();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tracer.restResponse).not.toHaveBeenCalled();

    controller.abort();
    await cancellation;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    firstBody.finish('first');
    await expect(first).resolves.toBe('first');
    await flushRequests();
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/first', '/api/v1/second', '/api/v1/third',
    ]);

    secondBody.finish('second');
    await second;
    await flushRequests();
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/api/v1/first', '/api/v1/second', '/api/v1/third', '/api/v1/fifth',
    ]);
    thirdBody.finish('third');
    await Promise.all([third, fifth]);
    expect(tracer.restRequest).toHaveBeenCalledTimes(4);
    expect(tracer.restResponse).toHaveBeenCalledTimes(4);
    expect(tracer.restFailure).not.toHaveBeenCalled();
  });

  it.each(['fetch', 'timeout', 'http', 'auth', 'json', 'body'] as const)(
    'releases the slot after a %s failure without changing the error contract',
    async (kind) => {
      const response = deferredResponse();
      const blockedBody = streamingResponse();
      const brokenBody = streamingResponse();
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => response.promise)
        .mockResolvedValueOnce(blockedBody.response)
        .mockImplementation(() => Promise.resolve(jsonResponse('next')));
      vi.stubGlobal('fetch', fetchMock);
      const markAuthRequired = vi.fn();
      const client = makeClient({ credentialStore: { getToken: () => 'token', markAuthRequired } });
      const first = client.get('/failure', undefined, { background: true }).catch((error: unknown) => error);
      const second = client.get('/blocked', undefined, { background: true });
      const third = client.get('/next', undefined, { background: true });
      await flushRequests();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      if (kind === 'fetch') response.reject(new TypeError('fetch failed'));
      else if (kind === 'timeout') response.reject(new DOMException('timed out', 'TimeoutError'));
      else if (kind === 'http') response.resolve(new Response(JSON.stringify({ msg: 'failed' }), { status: 503 }));
      else if (kind === 'auth') response.resolve(new Response(JSON.stringify({ code: 40101, msg: 'unauthorized' }), { status: 401 }));
      else if (kind === 'json') response.resolve(new Response('not JSON'));
      else {
        response.resolve(brokenBody.response);
        await flushRequests();
        brokenBody.fail(new TypeError('body failed'));
      }

      const error = await first;
      if (kind === 'http' || kind === 'auth') {
        expect(error).toMatchObject({ name: 'DaemonApiError', code: kind === 'auth' ? 40101 : 503 });
      } else {
        expect(error).toMatchObject({
          name: 'DaemonNetworkError',
          phase: kind === 'json' || kind === 'body' ? 'parse' : 'fetch',
        });
      }
      if (kind === 'json') expect(error).toMatchObject({ bodyPreview: 'not JSON' });
      expect(markAuthRequired).toHaveBeenCalledTimes(kind === 'auth' ? 1 : 0);
      await expect(third).resolves.toBe('next');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      blockedBody.finish();
      await second;
    },
  );

  it.each(['fetch', 'body'] as const)('releases a caller-aborted %s request with an abort trace instead of a failure trace', async (phase) => {
    const body = streamingResponse();
    const blockedBody = streamingResponse();
    const controller = new AbortController();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init: RequestInit) => {
        if (phase === 'body') {
          init.signal?.addEventListener('abort', () => body.fail(init.signal?.reason), { once: true });
          return Promise.resolve(body.response);
        }
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        });
      })
      .mockResolvedValueOnce(blockedBody.response)
      .mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const tracer = { restFailure: vi.fn(), restAbort: vi.fn() };
    const client = makeClient({ tracer });
    const request = client.get('/abort', undefined, { background: true, signal: controller.signal });
    const assertion = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    const blocked = client.get('/blocked', undefined, { background: true });
    const next = client.get('/next', undefined, { background: true });
    await flushRequests();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    controller.abort();
    await assertion;
    await next;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tracer.restFailure).not.toHaveBeenCalled();
    expect(tracer.restAbort).toHaveBeenCalledOnce();
    expect(tracer.restAbort).toHaveBeenCalledWith(expect.objectContaining({ method: 'GET', path: '/abort' }));
    blockedBody.finish();
    await blocked;
  });

  it('does not fetch pre-aborted requests or requests aborted between admission and fetch', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse()));
    vi.stubGlobal('fetch', fetchMock);
    const tracer = { restFailure: vi.fn(), restAbort: vi.fn() };
    const client = makeClient({ tracer });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(client.get('/pre-aborted', undefined, { background: true, signal: preAborted.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const controller = new AbortController();
    const request = client.get('/admitted', undefined, { background: true, signal: controller.signal });
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    await Promise.all(Array.from({ length: 3 }, () => client.get('/next', undefined, { background: true })));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(tracer.restFailure).not.toHaveBeenCalled();
    expect(tracer.restAbort).not.toHaveBeenCalled();
  });

  it('starts the network timeout after admission and traces queue wait separately', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
      .mockImplementation((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    vi.stubGlobal('fetch', fetchMock);
    const tracer = { restRequest: vi.fn(), restResponse: vi.fn(), restFailure: vi.fn() };
    const client = makeClient({ tracer });
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    const third = client.get('/third', undefined, { background: true, timeoutMs: 20 }).catch((error: unknown) => error);
    await flushRequests();
    expect(timeout).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledTimes(2);

    firstResponse.resolve(jsonResponse());
    await first;
    await flushRequests();
    expect(timeout).toHaveBeenLastCalledWith(20);
    expect(tracer.restRequest).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/third', queueMs: 100 }));
    await vi.advanceTimersByTimeAsync(19);
    expect(tracer.restFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await third).toMatchObject({ name: 'DaemonNetworkError', timeoutMs: 20, durationMs: 20 });
    expect(tracer.restFailure).toHaveBeenCalledOnce();
    expect(tracer.restFailure).toHaveBeenCalledWith(expect.objectContaining({ queueMs: 100, durationMs: 20 }));
    secondResponse.resolve(jsonResponse());
    await second;
  });

  it('settles pending requests on dispose, lets sent requests finish, and rejects later JSON requests', async () => {
    const firstResponse = deferredResponse();
    const secondResponse = deferredResponse();
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    const third = client.get('/third', undefined, { background: true });
    const fourth = client.get('/fourth', undefined, { background: true });
    const assertion = expect(Promise.all([third, fourth])).rejects.toMatchObject({ name: 'AbortError' });
    await flushRequests();
    client.dispose();
    client.dispose();
    await assertion;
    await expect(client.get('/later', undefined, { background: true })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(client.post('/later')).rejects.toMatchObject({ name: 'AbortError' });
    firstResponse.resolve(jsonResponse('first'));
    secondResponse.resolve(jsonResponse('second'));
    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when disposed between admission and fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    const request = client.get('/admitted', undefined, { background: true });
    client.dispose();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves blob, ZIP and form fetches outside the JSON request budget', async () => {
    const firstBody = streamingResponse();
    const secondBody = streamingResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(firstBody.response)
      .mockResolvedValueOnce(secondBody.response)
      .mockResolvedValueOnce(new Response('image'))
      .mockResolvedValueOnce(new Response('zip', { headers: { 'content-type': 'application/zip' } }))
      .mockResolvedValueOnce(jsonResponse('uploaded'));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    const first = client.get('/first', undefined, { background: true });
    const second = client.get('/second', undefined, { background: true });
    await flushRequests();
    const blob = client.getBlob('/blob');
    const zip = client.postZip('/export', {}, {});
    const form = client.postForm('/upload', new FormData());
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect((await blob).size).toBe(5);
    expect((await zip).blob.size).toBe(3);
    await expect(form).resolves.toBe('uploaded');
    firstBody.finish();
    secondBody.finish();
    await Promise.all([first, second]);
  });

  it('preserves 204 responses, allowed envelope errors and wire query parameters', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 40903, data: { aborted: false } })));
    vi.stubGlobal('fetch', fetchMock);
    const client = makeClient({});
    await expect(client.get('/empty', { page_size: 10, id: ['a', 'b'] }, { background: true })).resolves.toBeNull();
    await expect(client.post('/abort', {}, { background: true, allowCodes: [40903] })).resolves.toEqual({ aborted: false });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://test.local/api/v1/empty?page_size=10&id=a&id=b');
  });
});
