// apps/kimi-web/test/ws-lifecycle.test.ts
// Focused coverage of DaemonEventSocket reconnect + staleness detection, the
// foreground recovery path added so a frozen/backgrounded tab can recover
// without a full page reload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DaemonEventSocket, type DaemonEventSocketHandlers } from '../src/api/daemon/ws';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev?: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = FakeWebSocket.CLOSED;
  }

  emitMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function makeHandlers(): DaemonEventSocketHandlers & { states: boolean[] } {
  const states: boolean[] = [];
  return {
    states,
    onWireEvent: () => {},
    onResync: () => {},
    onConnectionState: (connected) => states.push(connected),
    onError: () => {},
  };
}

const WS_URL = 'ws://example.test/ws';
const CLIENT_ID = 'client_test';

// Frames the socket understands; only `type` (+ friends) matters here.
const SERVER_HELLO = {
  type: 'server_hello',
  payload: {
    ws_connection_id: 'conn_1',
    protocol_version: 1,
    heartbeat_ms: 30_000,
    max_event_buffer_size: 1000,
    capabilities: {},
  },
};

describe('DaemonEventSocket reconnect + staleness', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('reconnect() closes the old socket, detaches it, and opens a new one', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.emitMessage(SERVER_HELLO);
    expect(handlers.states).toEqual([true]);

    socket.reconnect();

    expect(first.closeCalls).toEqual([{ code: 1000, reason: 'reconnect' }]);
    // Old socket is fully detached so its late onclose cannot clobber the new.
    expect(first.onclose).toBeNull();
    expect(first.onmessage).toBeNull();
    // A fresh socket was created, and we reported the transient disconnect.
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(handlers.states).toEqual([true, false]);

    // A late onclose from the stale socket must NOT schedule another connect.
    first.onclose?.({ code: 1000, reason: 'reconnect', wasClean: true });
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('reconnect() is a no-op after close()', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    socket.close();
    socket.reconnect();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it('health() flips stale after a long silence and clears on the next frame', () => {
    vi.useFakeTimers();
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    first.emitMessage(SERVER_HELLO);

    // Threshold = max(2 * 30_000, 30_000 floor) = 60s.
    expect(socket.health().stale).toBe(false);

    vi.advanceTimersByTime(61_000);
    expect(socket.health().stale).toBe(true);

    // Any received frame (e.g. a server ping) proves the link is alive again.
    first.emitMessage({ type: 'ping', payload: { nonce: 'n1' } });
    expect(socket.health().stale).toBe(false);
  });

  it('health().open reflects the underlying readyState', () => {
    const handlers = makeHandlers();
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const first = FakeWebSocket.instances[0]!;
    expect(socket.health().open).toBe(true);
    first.readyState = FakeWebSocket.CLOSING;
    expect(socket.health().open).toBe(false);
  });
});

describe('DaemonEventSocket frame dispatch (multi-instance surface)', () => {
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    originalWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    vi.useRealTimers();
  });

  it('consumes session.list_changed (bare and event.-prefixed) via onSessionListChanged only', () => {
    let wireEvents = 0;
    let listChanged = 0;
    const handlers: DaemonEventSocketHandlers = {
      onWireEvent: () => {
        wireEvents += 1;
      },
      onResync: () => {},
      onConnectionState: () => {},
      onError: () => {},
      onSessionListChanged: () => {
        listChanged += 1;
      },
    };
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage(SERVER_HELLO);

    ws.emitMessage({ type: 'session.list_changed', payload: {} });
    ws.emitMessage({ type: 'event.session.list_changed', payload: {} });

    expect(listChanged).toBe(2);
    expect(wireEvents).toBe(0);
  });

  it('consumes skill_catalog.changed (bare and event.-prefixed) via onSkillCatalogChanged only', () => {
    let wireEvents = 0;
    let rawAgentEvents = 0;
    const changed: string[] = [];
    const handlers: DaemonEventSocketHandlers = {
      onWireEvent: () => {
        wireEvents += 1;
      },
      onRawAgentEvent: () => {
        rawAgentEvents += 1;
      },
      onResync: () => {},
      onConnectionState: () => {},
      onError: () => {},
      onSkillCatalogChanged: (sessionId) => {
        changed.push(sessionId);
      },
    };
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage(SERVER_HELLO);

    ws.emitMessage({
      type: 'skill_catalog.changed',
      seq: 1,
      session_id: 'sess_1',
      timestamp: '2026-01-01T00:00:00.000Z',
      volatile: true,
      payload: { type: 'skill_catalog.changed', sourceId: 'workspace-file' },
    });
    ws.emitMessage({
      type: 'event.skill_catalog.changed',
      seq: 2,
      session_id: 'sess_2',
      timestamp: '2026-01-01T00:00:00.000Z',
      volatile: true,
      payload: { type: 'skill_catalog.changed', sourceId: 'plugin' },
    });

    expect(changed).toEqual(['sess_1', 'sess_2']);
    expect(wireEvents).toBe(0);
    expect(rawAgentEvents).toBe(0);
  });

  it('passes connection-level error-frame details through to onError', () => {
    const errors: Array<{ code: number; msg: string; fatal: boolean; details: unknown }> = [];
    const handlers: DaemonEventSocketHandlers = {
      onWireEvent: () => {},
      onResync: () => {},
      onConnectionState: () => {},
      onError: (code, msg, fatal, details) => {
        errors.push({ code, msg, fatal, details });
      },
    };
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage(SERVER_HELLO);

    const ownership = { kind: 'held-by-peer', phase: 'routable', address: 'http://127.0.0.1:58628' };
    ws.emitMessage({ type: 'error', payload: { code: 40921, msg: 'session held by peer', fatal: false, details: ownership } });

    expect(errors).toEqual([{ code: 40921, msg: 'session held by peer', fatal: false, details: ownership }]);
  });

  it('keeps session-scoped error frames on the agent-event path (no details leak to onError)', () => {
    const errors: unknown[] = [];
    const raw: Array<{ type: string; session_id: string; payload: unknown }> = [];
    const handlers: DaemonEventSocketHandlers = {
      onWireEvent: () => {},
      onResync: () => {},
      onConnectionState: () => {},
      onError: (...args) => {
        errors.push(args);
      },
      onRawAgentEvent: (frame) => {
        raw.push(frame);
      },
    };
    const socket = new DaemonEventSocket(WS_URL, CLIENT_ID, handlers);
    socket.connect();
    const ws = FakeWebSocket.instances[0]!;
    ws.emitMessage(SERVER_HELLO);

    ws.emitMessage({
      type: 'error',
      session_id: 'sess_1',
      seq: 7,
      timestamp: 't',
      payload: { code: 40300, msg: 'provider denied' },
    });

    expect(errors).toEqual([]);
    expect(raw).toEqual([
      {
        type: 'error',
        seq: 7,
        session_id: 'sess_1',
        timestamp: 't',
        payload: { code: 40300, msg: 'provider denied' },
      },
    ]);
  });
});
