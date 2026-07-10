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
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.last = this;
  }
  send(): void {}
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
});
