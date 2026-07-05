import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createKimiEventClient,
  type KimiEvent,
  type WebSocketLike,
} from './ws.js';
import type { Config } from '../config.js';

function createTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    telegramBotToken: 'tg-token',
    databasePath: ':memory:',
    pairingCodeTtlMinutes: 10,
    logLevel: 'info',
    kimiServerUrl: 'http://localhost:58627',
    kimiBearerToken: 'kimi-token',
    kimiTokenFile: '~/.kimi-code/token',
    kimiWsUrl: 'ws://localhost:58627',
    ...overrides,
  };
}

class FakeWebSocket extends EventTarget implements WebSocketLike {
  static lastInstance: FakeWebSocket | null = null;

  url: string;
  protocols?: string | string[];
  readyState = 0;
  sent: string[] = [];
  closed = false;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.lastInstance = this;
  }

  on(
    event: 'open' | 'message' | 'error' | 'close',
    listener: (data?: unknown) => void
  ): void {
    this.addEventListener(event, (evt) => {
      if (event === 'message' && evt instanceof MessageEvent) {
        listener(evt.data);
      } else if (event === 'error' && evt instanceof ErrorEvent) {
        listener({ message: evt.message });
      } else if (event === 'close' && evt instanceof CloseEvent) {
        listener();
      } else {
        listener();
      }
    });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.dispatchEvent(new CloseEvent('close', { wasClean: true }));
  }

  // Helper to simulate server-side events
  simulateOpen() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  simulateMessage(data: string) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }

  simulateError(message: string) {
    this.dispatchEvent(new ErrorEvent('error', { message }));
  }

  simulateClose() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent('close', { wasClean: false }));
  }
}

describe('createKimiEventClient', () => {
  let events: KimiEvent[] = [];

  beforeEach(() => {
    FakeWebSocket.lastInstance = null;
    events = [];
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createClient(
    config = createTestConfig(),
    options: Omit<Parameters<typeof createKimiEventClient>[1], 'onEvent'> = {}
  ) {
    return createKimiEventClient(config, {
      onEvent: (event) => events.push(event),
      webSocketFactory: (url, protocols) =>
        new FakeWebSocket(url, protocols) as unknown as WebSocketLike,
      ...options,
    });
  }

  it('connects to the WebSocket URL with bearer subprotocol', () => {
    const client = createClient();
    client.start();

    const socket = FakeWebSocket.lastInstance;
    expect(socket).not.toBeNull();
    expect(socket?.url).toBe('ws://localhost:58627/api/v1/ws');
    expect(socket?.protocols).toEqual(['bearer.kimi-token']);
  });

  it('can authenticate via query parameter', () => {
    const client = createClient(
      createTestConfig({
        kimiServerUrl: 'http://localhost:58627',
        kimiWsUrl: 'ws://localhost:58627',
      }),
      {
        authMode: 'query',
      }
    );
    client.start();

    const socket = FakeWebSocket.lastInstance;
    expect(socket?.url).toBe(
      'ws://localhost:58627/api/v1/ws?token=kimi-token'
    );
    expect(socket?.protocols).toBeUndefined();
  });

  it('delivers parsed events to the handler', () => {
    const client = createClient();
    client.start();

    const socket = FakeWebSocket.lastInstance!;
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ type: 'turn.ended', payload: {} }));

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'turn.ended', payload: {} });
  });

  it('ignores malformed JSON messages', () => {
    const client = createClient();
    client.start();

    const socket = FakeWebSocket.lastInstance!;
    socket.simulateOpen();
    socket.simulateMessage('not-json');

    expect(events).toHaveLength(0);
  });

  it('ignores messages missing a type', () => {
    const client = createClient();
    client.start();

    const socket = FakeWebSocket.lastInstance!;
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ payload: {} }));

    expect(events).toHaveLength(0);
  });

  it('reconnects after the connection closes', () => {
    const client = createClient();
    client.start();

    const firstSocket = FakeWebSocket.lastInstance!;
    firstSocket.simulateOpen();
    firstSocket.simulateClose();

    expect(FakeWebSocket.lastInstance).toBe(firstSocket);

    vi.advanceTimersByTime(1_000);

    const secondSocket = FakeWebSocket.lastInstance!;
    expect(secondSocket).not.toBe(firstSocket);
    expect(secondSocket.url).toBe('ws://localhost:58627/api/v1/ws');
  });

  it('backs off reconnect attempts exponentially', () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout');
    const client = createClient();
    client.start();

    for (let i = 0; i < 3; i++) {
      FakeWebSocket.lastInstance!.simulateClose();
      const timeoutCalls = spy.mock.calls
        .slice(timeouts.length)
        .map((call) => Number(call[1]));
      timeouts.push(...timeoutCalls);
      vi.advanceTimersByTime(Math.min(1_000 * 2 ** i, 30_000));
    }

    expect(timeouts.slice(0, 3)).toEqual([1_000, 2_000, 4_000]);
  });

  it('caps reconnect delay at 30 seconds', () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(global, 'setTimeout');
    const client = createClient();
    client.start();

    for (let i = 0; i < 6; i++) {
      FakeWebSocket.lastInstance!.simulateClose();
      const timeoutCalls = spy.mock.calls
        .slice(timeouts.length)
        .map((call) => Number(call[1]));
      timeouts.push(...timeoutCalls);
      vi.advanceTimersByTime(30_000);
    }

    expect(Math.max(...timeouts)).toBe(30_000);
    const lastTimeout = timeouts[timeouts.length - 1];
    expect(lastTimeout).toBe(30_000);
  });

  it('stops reconnecting after stop is called', () => {
    const client = createClient();
    client.start();

    const firstSocket = FakeWebSocket.lastInstance!;
    firstSocket.simulateOpen();
    client.stop();

    firstSocket.simulateClose();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.lastInstance).toBe(firstSocket);
    expect(firstSocket.closed).toBe(true);
  });

  it('cancels a pending reconnect timeout when stopped', () => {
    const client = createClient();
    client.start();

    const firstSocket = FakeWebSocket.lastInstance!;
    firstSocket.simulateOpen();
    firstSocket.simulateClose();

    client.stop();
    vi.advanceTimersByTime(60_000);

    expect(FakeWebSocket.lastInstance).toBe(firstSocket);
    expect(firstSocket.closed).toBe(true);
  });

  it('logs WebSocket errors', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = createClient(createTestConfig(), { logger });
    client.start();

    const socket = FakeWebSocket.lastInstance!;
    socket.simulateOpen();
    socket.simulateError('connection failed');

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'ws://localhost:58627/api/v1/ws',
        error: expect.objectContaining({ message: 'connection failed' }),
      }),
      'kimi-code WebSocket error'
    );
  });

  it('encodes the token in query auth mode', () => {
    const client = createClient(
      createTestConfig({
        kimiBearerToken: 'token with spaces & symbols=/?',
      }),
      { authMode: 'query' }
    );
    client.start();

    const socket = FakeWebSocket.lastInstance;
    expect(socket?.url).toBe(
      'ws://localhost:58627/api/v1/ws?token=token%20with%20spaces%20%26%20symbols%3D%2F%3F'
    );
  });

  it('is idempotent when start is called multiple times', () => {
    const client = createClient();
    client.start();
    const firstSocket = FakeWebSocket.lastInstance!;

    client.start();
    const secondSocket = FakeWebSocket.lastInstance!;

    expect(secondSocket).toBe(firstSocket);
  });

  it('schedules reconnect when the WebSocket factory throws', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    let attempt = 0;
    const client = createKimiEventClient(createTestConfig(), {
      onEvent: (event) => events.push(event),
      webSocketFactory: () => {
        attempt++;
        if (attempt === 1) {
          throw new Error('factory boom');
        }
        return new FakeWebSocket('ws://localhost:58627/api/v1/ws') as unknown as WebSocketLike;
      },
      logger,
    });
    client.start();

    expect(attempt).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      'kimi-code WebSocket factory threw'
    );

    vi.advanceTimersByTime(1_000);

    expect(attempt).toBe(2);
  });

  it('logs when the event handler throws', () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const client = createKimiEventClient(createTestConfig(), {
      onEvent: () => {
        throw new Error('handler boom');
      },
      webSocketFactory: (url, protocols) =>
        new FakeWebSocket(url, protocols) as unknown as WebSocketLike,
      logger,
    });
    client.start();

    const socket = FakeWebSocket.lastInstance!;
    socket.simulateOpen();
    socket.simulateMessage(JSON.stringify({ type: 'turn.ended', payload: {} }));

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'turn.ended', error: expect.any(Error) }),
      'Event handler threw'
    );
  });
});
