// packages/app-core/test/daemon-client.test.ts
// DaemonKimiWebApi public REST adapter: session export binary/error contracts,
// getSessionGoal wire → app mapping, and raw stream-coordinate delivery.
// Wiring: real client/projector; fetch or WebSocket is stubbed at the network
// boundary; the tracer is a recording fake.
// Run: pnpm exec vitest run packages/app-core/test/daemon-client.test.ts

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonKimiWebApi } from '../src/api/daemon/client';
import { createAgentProjector } from '../src/api/daemon/agentEventProjector';
import { DaemonApiError, DaemonNetworkError, isDaemonTimeoutError } from '../src/api/errors';
import type { RestRequestInfo, Translator } from '../src/contracts';
import type { AppEvent, KimiEventConnection, KimiEventMeta } from '../src/api/types';

const t: Translator = (key) => key;
const tracedRequests: RestRequestInfo[] = [];

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readonly OPEN = FakeWebSocket.OPEN;
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event?: CloseEvent) => void) | null = null;

  constructor(_url: string, _protocols?: string | string[]) {
    FakeWebSocket.instances.push(this);
  }

  send(_data: string): void {}

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, msg: '', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const WIRE_GOAL = {
  goalId: 'goal_1',
  objective: 'fix all lint warnings',
  status: 'active',
  turnsUsed: 1,
  tokensUsed: 0,
  wallClockMs: 0,
  budget: {
    tokenBudget: null,
    turnBudget: null,
    wallClockBudgetMs: null,
    remainingTokens: null,
    remainingTurns: null,
    remainingWallClockMs: null,
    tokenBudgetReached: false,
    turnBudgetReached: false,
    wallClockBudgetReached: false,
    overBudget: false,
  },
};

function createApi(): DaemonKimiWebApi {
  return new DaemonKimiWebApi({
    origin: 'http://daemon.test',
    identity: {
      clientId: 'web_test',
      clientName: 'test',
      clientVersion: '0.0.0',
      clientUiMode: 'test',
    },
    tracer: {
      restRequest: (info) => tracedRequests.push(info),
    },
    projectorFactory: () => createAgentProjector({ t }),
  });
}

describe('DaemonKimiWebApi.exportSession', () => {
  beforeEach(() => {
    vi.stubGlobal('location', { search: '?debug=1' });
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  it('posts the Web log to the encoded session export endpoint and returns the ZIP', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75, 3, 4]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="session-export.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess/1', '{"event":"safe"}');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/export',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ web_log: '{"event":"safe"}' }),
    });
    expect(result.fileName).toBe('session-export.zip');
    expect(result.blob.size).toBe(4);
  });

  it('sends the desktop flag only when requested', async () => {
    const zipResponse = () =>
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      });
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(zipResponse()));

    await createApi().exportSession('sess_1', 'log', { desktop: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log', desktop: true }),
    });

    vi.mocked(fetch).mockClear();
    await createApi().exportSession('sess_1', 'log');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log' }),
    });
  });

  it('retries without the desktop flag when the server predates it', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 40001, msg: 'unrecognized key: desktop', request_id: 'req_old' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([80, 75, 3, 4]), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-disposition': 'attachment; filename="session-export.zip"',
          },
        }),
      );

    const result = await createApi().exportSession('sess_1', 'log', { desktop: true });

    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log', desktop: true }),
    });
    expect(vi.mocked(fetch).mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ web_log: 'log' }),
    });
    expect(result.fileName).toBe('session-export.zip');
  });

  it('falls back to a session-id ZIP name for an unsafe response filename', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: {
          'content-type': 'application/zip',
          'content-disposition': 'attachment; filename="../credentials.zip"',
        },
      }),
    );

    const result = await createApi().exportSession('sess_1');

    expect(result.fileName).toBe('sess_1.zip');
  });

  it('parses a JSON error envelope returned by the export endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ code: 41301, msg: 'export too large', request_id: 'req_server' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const caught = await createApi()
      .exportSession('sess_1', 'log')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonApiError);
    expect(caught).toMatchObject({ code: 41301, requestId: 'req_server' });
  });

  it('rejects a successful response whose media type is not a ZIP', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('not a zip', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const caught = await createApi().exportSession('sess_1').catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ phase: 'parse', contentType: 'text/plain' });
  });

  it('records only Web-log counts in the request trace', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(new Uint8Array([80, 75]), {
        status: 200,
        headers: { 'content-type': 'application/zip' },
      }),
    );
    const secret = 'PROMPT_CONTENT_MUST_NOT_ENTER_TRACE';

    await createApi().exportSession('sess_1', `${secret}\nsecond line`);

    // The client must hand the tracer only Web-log counts, never the content.
    const trace = JSON.stringify(tracedRequests);
    expect(tracedRequests).not.toHaveLength(0);
    expect(trace).not.toContain(secret);
    expect(trace).toContain('web_log_bytes');
    expect(trace).toContain('web_log_entries');
  });
});

describe('DaemonKimiWebApi.generateSessionTitle', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    tracedRequests.length = 0;
  });

  afterEach(() => {
    tracedRequests.length = 0;
    vi.unstubAllGlobals();
  });

  it('posts to the title/generate endpoint and returns the generated title', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ title: 'Fix lint warnings' }));

    const result = await createApi().generateSessionTitle('sess/1');

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess%2F1/title/generate',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(result).toBe('Fix lint warnings');
  });

  it('sends the force flag only when requested', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ title: 't' }));

    await createApi().generateSessionTitle('sess_1', { force: true });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ force: true }),
    });

    vi.mocked(fetch).mockClear();
    await createApi().generateSessionTitle('sess_1');
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({}),
    });
  });

  it('passes the excerpt source through when given', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({ title: 't' }));

    await createApi().generateSessionTitle('sess_1', { source: 'first_turn' });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ source: 'first_turn' }),
    });

    vi.mocked(fetch).mockClear();
    await createApi().generateSessionTitle('sess_1', { force: true, source: 'digest' });
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ force: true, source: 'digest' }),
    });
  });

  it('returns null when generation is unavailable (40922)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 40922,
          msg: 'session title generation is unavailable',
          request_id: 'req_1',
        }),
        { status: 409, headers: { 'content-type': 'application/json' } },
      ),
    );

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });

  it('returns null for a bare 404 from a server predating the route', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('Not Found', { status: 404, headers: { 'content-type': 'text/plain' } }),
    );

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });

  it('returns null on a network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });

  it('returns null when the success envelope carries no usable title', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope({}));

    await expect(createApi().generateSessionTitle('sess_1')).resolves.toBeNull();
  });
});

describe('DaemonKimiWebApi fork timeout budget', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // What fetch rejects with when our own AbortSignal.timeout fires.
  const timeoutRejection = () =>
    Promise.reject(new DOMException('signal timed out', 'TimeoutError'));

  it('forkSession waits five minutes before aborting', async () => {
    vi.mocked(fetch).mockImplementation(timeoutRejection);

    const caught = await createApi()
      .forkSession('sess_1')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(caught).toMatchObject({ timeoutMs: 300_000, phase: 'fetch' });
    expect(isDaemonTimeoutError(caught)).toBe(true);
  });

  it('createChildSession shares the fork budget (the daemon forks server-side)', async () => {
    vi.mocked(fetch).mockImplementation(timeoutRejection);

    const caught = await createApi()
      .createChildSession('sess_1')
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ timeoutMs: 300_000 });
  });

  it('ordinary session actions keep the default 30s budget', async () => {
    vi.mocked(fetch).mockImplementation(timeoutRejection);

    const caught = await createApi()
      .undoSession('sess_1')
      .catch((error: unknown) => error);

    expect(caught).toMatchObject({ timeoutMs: 30_000 });
    expect(isDaemonTimeoutError(caught)).toBe(true);
  });

  it('a connect failure is not reported as a timeout', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'));

    const caught = await createApi()
      .forkSession('sess_1')
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(DaemonNetworkError);
    expect(isDaemonTimeoutError(caught)).toBe(false);
  });
});

describe('DaemonKimiWebApi.getSessionGoal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a present goal snapshot', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(WIRE_GOAL));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal?.objective).toBe('fix all lint warnings');
    expect(goal?.status).toBe('active');
    expect(goal?.turnsUsed).toBe(1);
  });

  it('maps null to null (no active goal)', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    const goal = await createApi().getSessionGoal('sess_1');
    expect(goal).toBeNull();
  });

  it('requests the session goal endpoint', async () => {
    vi.mocked(fetch).mockResolvedValue(envelope(null));
    await createApi().getSessionGoal('sess_42');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'http://daemon.test/api/v1/sessions/sess_42/goal',
    );
  });
});

describe('DaemonKimiWebApi.connectEvents', () => {
  let connection: KimiEventConnection | undefined;

  afterEach(() => {
    connection?.close();
    connection = undefined;
    vi.unstubAllGlobals();
  });

  it('delivers raw assistant stream coordinates with the projected delta', () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: Array<{ event: AppEvent; meta: KimiEventMeta }> = [];
    connection = createApi().connectEvents({
      onEvent(event, meta) {
        received.push({ event, meta });
      },
      onResync() {},
      onError() {},
      onConnectionChange() {},
    });
    const socket = FakeWebSocket.instances[0]!;

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'turn.started',
      seq: 1,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { agentId: 'main', turnId: 7 },
    });
    socket.emit({
      type: 'turn.step.started',
      seq: 2,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: { agentId: 'main', turnId: 7, step: 1 },
    });
    socket.emit({
      type: 'assistant.delta',
      seq: 2,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      volatile: true,
      offset: 0,
      payload: { agentId: 'main', turnId: 7, delta: 'hello' },
    });
    socket.emit({
      type: 'thinking.delta',
      seq: 2,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      volatile: true,
      offset: 0,
      payload: { agentId: 'main', turnId: 7, delta: 'thought' },
    });

    const delta = received.find(({ event }) => event.type === 'assistantDelta');
    expect(delta).toMatchObject({
      event: {
        type: 'assistantDelta',
        sessionId: 'session-1',
        delta: { text: 'hello' },
      },
      meta: {
        sessionId: 'session-1',
        seq: 2,
        stream: { turnId: 7, offset: 0, kind: 'text' },
      },
    });

    const thinking = received.find(
      ({ event }) => event.type === 'assistantDelta' && event.delta.thinking !== undefined,
    );
    expect(thinking).toMatchObject({
      event: {
        type: 'assistantDelta',
        sessionId: 'session-1',
        delta: { thinking: 'thought' },
      },
      meta: {
        sessionId: 'session-1',
        seq: 2,
        stream: { turnId: 7, offset: 0, kind: 'thinking' },
      },
    });
  });

  it('projects list-level work facts from the global session event', () => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket);
    const received: AppEvent[] = [];
    connection = createApi().connectEvents({
      onEvent(event) {
        received.push(event);
      },
      onResync() {},
      onError() {},
      onConnectionChange() {},
    });
    const [socket] = FakeWebSocket.instances;
    if (socket === undefined) throw new Error('WebSocket was not created');

    socket.emit({ type: 'server_hello', payload: { protocol_version: 2 } });
    socket.emit({
      type: 'event.session.work_changed',
      seq: 1,
      session_id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      payload: {
        busy: true,
        main_turn_active: false,
        pending_interaction: 'question',
      },
    });

    expect(received).toContainEqual({
      type: 'sessionWorkChanged',
      sessionId: 'session-1',
      busy: true,
      mainTurnActive: false,
      pendingInteraction: 'question',
      lastTurnReason: undefined,
    });
  });
});
