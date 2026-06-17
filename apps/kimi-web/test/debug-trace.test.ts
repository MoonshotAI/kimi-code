// apps/kimi-web/test/debug-trace.test.ts
//
// KAP debug trace: the side-channel recording of REST calls and WS frames.
// Drives the REAL DaemonHttpClient (stubbed fetch) and DaemonEventSocket
// (stubbed WebSocket) and asserts what a user would see in the debug panel:
// request/response/error entries, redacted secrets, truncated payloads,
// bounded buffer, JSONL export.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonHttpClient } from '../src/api/daemon/http';
import { DaemonEventSocket, type DaemonEventSocketHandlers } from '../src/api/daemon/ws';
import {
  clearTrace,
  installClientErrorCapture,
  sanitizeForTrace,
  traceEntries,
  traceToJsonl,
  traceWsIn,
} from '../src/debug/trace';

function okEnvelope(data: unknown): Response {
  return new Response(
    JSON.stringify({ code: 0, msg: 'ok', data, request_id: 'req_env_1' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errEnvelope(code: number, msg: string): Response {
  return new Response(
    JSON.stringify({ code, msg, data: null, request_id: 'req_env_2' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

beforeEach(() => {
  // Opt the trace in the way a user would (the localStorage switch).
  localStorage.setItem('kimi-web.debug', '1');
  clearTrace();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('client-side error capture', () => {
  it('folds console.error into the trace so the export includes app errors', () => {
    const original = console.error;
    installClientErrorCapture();
    try {
      console.error('render failed', new Error('boom'));
    } finally {
      console.error = original; // undo the install-once wrap for other tests
    }
    const entry = traceEntries().find((e) => e.kind === 'client:error');
    expect(entry).toBeDefined();
    expect(entry!.source).toBe('client');
    expect(entry!.label).toContain('render failed');
    // The exported JSONL carries the client entry alongside network traffic.
    expect(traceToJsonl().includes('"client:error"')).toBe(true);
  });
});

describe('REST tracing via DaemonHttpClient', () => {
  it('records request + response with envelope code, status, duration and requestId', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okEnvelope({ id: 'ses_1' })));
    const http = new DaemonHttpClient('http://example.test:58627');

    await http.post('/sessions', { metadata: { cwd: '/repo' } });

    const entries = traceEntries();
    const request = entries.find((e) => e.kind === 'rest:request');
    const response = entries.find((e) => e.kind === 'rest:response');
    expect(request).toBeDefined();
    expect(request!.method).toBe('POST');
    expect(request!.path).toBe('/sessions');
    expect(request!.requestId).toMatch(/./);
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    expect(response!.code).toBe(0);
    expect(typeof response!.durationMs).toBe('number');
    expect(response!.requestId).toBe(request!.requestId);
    const detail = response!.detail as { envelope: { request_id: string } };
    expect(detail.envelope.request_id).toBe('req_env_1');
  });

  it('sends client identity headers when configured', async () => {
    const fetchMock = vi.fn(async () => okEnvelope({ id: 'ses_1' }));
    vi.stubGlobal('fetch', fetchMock);
    const http = new DaemonHttpClient('http://example.test:58627', {
      clientId: 'web_test_client',
      clientName: 'kimi-code-web',
      clientVersion: '0.1.1',
      clientUiMode: 'web',
    });

    await http.post('/sessions', { metadata: { cwd: '/repo' } });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Kimi-Client-Id']).toBe('web_test_client');
    expect(headers['X-Kimi-Client-Name']).toBe('kimi-code-web');
    expect(headers['X-Kimi-Client-Version']).toBe('0.1.1');
    expect(headers['X-Kimi-Client-Ui-Mode']).toBe('web');
  });

  it('redacts sensitive request fields (api_key / authorization)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okEnvelope({})));
    const http = new DaemonHttpClient('http://example.test:58627');

    await http.post('/providers', { api_key: 'YOUR_API_KEY', authorization: 'Bearer x' });

    const request = traceEntries().find((e) => e.kind === 'rest:request');
    const body = (request!.detail as { body: Record<string, unknown> }).body;
    expect(body['api_key']).toBe('[redacted]');
    expect(body['authorization']).toBe('[redacted]');
  });

  it('records a daemon API error (non-zero envelope code) as rest:error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => errEnvelope(40401, 'session does not exist')));
    const http = new DaemonHttpClient('http://example.test:58627');

    await expect(http.get('/sessions/ses_x')).rejects.toThrow();

    const entry = traceEntries().find((e) => e.kind === 'rest:error');
    expect(entry).toBeDefined();
    expect(entry!.code).toBe(40401);
    expect(entry!.label).toContain('session does not exist');
  });

  it('records a network failure with its phase', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const http = new DaemonHttpClient('http://example.test:58627');

    await expect(http.get('/healthz')).rejects.toThrow();

    const entry = traceEntries().find((e) => e.kind === 'rest:error');
    expect(entry).toBeDefined();
    expect((entry!.detail as { phase: string }).phase).toBe('fetch');
  });

  it('records a JSON parse failure with HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>busy</html>', { status: 502 })));
    const http = new DaemonHttpClient('http://example.test:58627');

    await expect(http.get('/healthz')).rejects.toThrow();

    const entry = traceEntries().find((e) => e.kind === 'rest:error');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe(502);
    expect((entry!.detail as { phase: string }).phase).toBe('parse');
  });
});

describe('WS tracing via DaemonEventSocket', () => {
  class FakeWebSocket {
    static OPEN = 1;
    static last: FakeWebSocket | null = null;
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: ((ev?: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    readyState = 1;
    sent: string[] = [];
    constructor(public url: string) {
      FakeWebSocket.last = this;
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {}
  }

  const handlers: DaemonEventSocketHandlers = {
    onWireEvent: () => {},
    onRawAgentEvent: () => {},
    onResync: () => {},
    onConnectionState: () => {},
    onError: () => {},
  };

  it('records lifecycle, handshake frames and event frames with session/seq/offset', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const socket = new DaemonEventSocket('ws://example.test/ws', 'client_1', handlers);
    socket.subscribe('ses_1', { seq: 0 });
    socket.connect();
    const fake = FakeWebSocket.last!;
    fake.onopen?.();
    fake.onmessage?.({ data: JSON.stringify({ type: 'server_hello', payload: {} }) });
    fake.onmessage?.({
      data: JSON.stringify({
        type: 'message.delta',
        session_id: 'ses_1',
        seq: 7,
        offset: 3,
        timestamp: '2026-06-12T00:00:00Z',
        payload: { delta: 'hi' },
      }),
    });
    fake.onclose?.({ code: 1006, reason: 'gone', wasClean: false });
    socket.close();

    const entries = traceEntries();
    const kinds = entries.map((e) => `${e.kind}:${e.eventType ?? ''}`);
    expect(kinds).toContain('ws:lifecycle:connect');
    expect(kinds).toContain('ws:lifecycle:open');
    expect(kinds).toContain('ws:in:server_hello');
    expect(kinds).toContain('ws:out:client_hello');
    expect(kinds).toContain('ws:lifecycle:close');
    expect(kinds).toContain('ws:lifecycle:reconnect-scheduled');

    const event = entries.find((e) => e.eventType === 'message.delta');
    expect(event).toBeDefined();
    expect(event!.sessionId).toBe('ses_1');
    expect(event!.seq).toBe(7);
    expect(event!.offset).toBe(3);

    const hello = entries.find((e) => e.kind === 'ws:out' && e.eventType === 'client_hello');
    const helloDetail = hello!.detail as { payload: { subscriptions: string[] } };
    expect(helloDetail.payload.subscriptions).toContain('ses_1');
  });
});

describe('sanitization + buffer bounds + export', () => {
  it('truncates long strings and elides base64-like blobs', () => {
    const long = 'lorem ipsum '.repeat(200); // 2400 chars, with spaces (not base64-like)
    const b64 = 'A'.repeat(300);
    const out = sanitizeForTrace({ text: long, image: b64 }) as Record<string, string>;
    expect(out['text']!.length).toBeLessThan(600);
    expect(out['text']).toContain('[+1900 chars]');
    expect(out['image']).toContain('base64-like');
  });

  it('keeps at most 1000 entries (ring buffer)', () => {
    for (let i = 0; i < 1100; i++) {
      traceWsIn({ type: 'ping', payload: { nonce: i } });
    }
    expect(traceEntries().length).toBe(1000);
    // Oldest entries dropped — the first kept nonce is 100.
    const first = traceEntries()[0]!.detail as { nonce: number };
    expect(first.nonce).toBe(100);
  });

  it('exports JSONL that parses back into entries', () => {
    traceWsIn({ type: 'ping', payload: { nonce: 1 } });
    const jsonl = traceToJsonl();
    const lines = jsonl.split('\n');
    expect(lines.length).toBe(traceEntries().length);
    const parsed = JSON.parse(lines[0]!) as { kind: string };
    expect(parsed.kind).toBe('ws:in');
  });
});
