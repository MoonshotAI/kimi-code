import { describe, expect, it, vi } from 'vitest';
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
  onResync: () => {},
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
      wsUrl: 'ws://test.local/api/v1/ws?client_id=c1',
      clientId: 'c1',
      handlers: noopHandlers,
      tracer,
      credentialStore,
    });

    socket.connect();

    expect(FakeWebSocket.last?.protocols).toEqual(['kimi-code.bearer.ws_tok']);
  });

  it('keeps legacy raw events main-only without changing the web default', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const desktop = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws?client_id=c1',
      clientId: 'c1',
      handlers: noopHandlers,
      mainAgentOnly: true,
    });
    desktop.subscribe('s1');
    desktop.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onmessage?.({
      data: JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 30_000 } }),
    });

    expect(ws.sent[0]).toMatchObject({
      type: 'client_hello',
      payload: { subscriptions: ['s1'], agent_filter: { s1: ['main'] } },
    });
    desktop.markSideChannelAgent('s1', 'agent-btw');
    expect(ws.sent.at(-1)).toMatchObject({
      type: 'subscribe',
      payload: {
        session_ids: ['s1'],
        agent_filter: { s1: ['main', 'agent-btw'] },
      },
    });

    const web = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws?client_id=c2',
      clientId: 'c2',
      handlers: noopHandlers,
    });
    web.subscribe('s2');
    web.connect();
    const webSocket = FakeWebSocket.last!;
    webSocket.readyState = FakeWebSocket.OPEN;
    webSocket.onmessage?.({
      data: JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 30_000 } }),
    });
    expect((webSocket.sent[0] as { payload: object }).payload).not.toHaveProperty('agent_filter');
  });

  it('replaces one auxiliary Transcript subscription atomically and detaches it', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws?client_id=c1',
      clientId: 'c1',
      handlers: noopHandlers,
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onmessage?.({
      data: JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 30_000 } }),
    });
    ws.sent = [];

    socket.subscribeTranscript('s1', 'agent-a', 4);
    socket.subscribeTranscript('s1', 'agent-b', 8);
    socket.unsubscribeTranscript('s1', ['agent-b']);

    expect(ws.sent).toEqual([
      expect.objectContaining({
        type: 'subscribe_v2',
        payload: {
          session_id: 's1',
          transcript: { 'agent-a': 'delta' },
          transcript_since: { 'agent-a': 4 },
        },
      }),
      expect.objectContaining({
        type: 'subscribe_v2',
        payload: {
          session_id: 's1',
          transcript: { 'agent-b': 'delta' },
          transcript_since: { 'agent-b': 8 },
        },
      }),
      expect.objectContaining({
        type: 'unsubscribe_v2',
        payload: { session_id: 's1', agent_ids: ['agent-b'] },
      }),
    ]);
  });

  it('routes Transcript reset and ops outside the legacy event classifier', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onTranscriptReset = vi.fn();
    const onTranscriptOps = vi.fn();
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws?client_id=c1',
      clientId: 'c1',
      handlers: { ...noopHandlers, onTranscriptReset, onTranscriptOps },
    });
    socket.connect();
    const ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'transcript.reset',
        session_id: 's1',
        payload: {
          type: 'transcript.reset',
          agent_id: 'agent-a',
          snapshot: {
            items: [],
            tasks: [],
            interactions: [],
            attachments: [],
            todos: [],
            prompts: [],
            meta: {},
          },
          has_more_older: false,
          seq: 3,
        },
      }),
    });
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'transcript.ops',
        session_id: 's1',
        payload: {
          type: 'transcript.ops',
          agent_id: 'agent-a',
          ops: [{ op: 'meta.merge', meta: { activity: 'turn' } }],
          seq: 4,
        },
      }),
    });

    expect(onTranscriptReset).toHaveBeenCalledWith(
      's1',
      'agent-a',
      expect.objectContaining({ items: [], hasMoreOlder: false }),
      3,
    );
    expect(onTranscriptOps).toHaveBeenCalledWith(
      's1',
      'agent-a',
      [{ op: 'meta.merge', meta: { activity: 'turn' } }],
      4,
    );
  });

  it('does not advance the reconnect cursor when the consumer rejects a sequence gap', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket({
      wsUrl: 'ws://test.local/api/v1/ws?client_id=c1',
      clientId: 'c1',
      handlers: {
        ...noopHandlers,
        onTranscriptOps: () => false,
      },
    });
    socket.connect();
    let ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onmessage?.({
      data: JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 30_000 } }),
    });
    socket.subscribeTranscript('s1', 'agent-a', 3);
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'transcript.ops',
        session_id: 's1',
        payload: {
          type: 'transcript.ops',
          agent_id: 'agent-a',
          ops: [{ op: 'meta.merge', meta: { activity: 'turn' } }],
          seq: 5,
        },
      }),
    });

    socket.reconnect();
    ws = FakeWebSocket.last!;
    ws.readyState = FakeWebSocket.OPEN;
    ws.onmessage?.({
      data: JSON.stringify({ type: 'server_hello', payload: { heartbeat_ms: 30_000 } }),
    });

    expect(ws.sent).toContainEqual(
      expect.objectContaining({
        type: 'subscribe_v2',
        payload: {
          session_id: 's1',
          transcript: { 'agent-a': 'delta' },
          transcript_since: { 'agent-a': 3 },
        },
      }),
    );
  });
});
