import type { Config } from '../config.js';
import WebSocket from 'ws';

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/**
 * An event delivered over the kimi-code WebSocket stream.
 */
export interface KimiEvent {
  type: string;
  payload: unknown;
  sessionId?: string;
}

/**
 * Minimal WebSocket surface used by the event client. This abstraction keeps
 * the client testable without a real network connection.
 */
export interface WebSocketLike {
  on(event: 'open' | 'message' | 'error' | 'close', listener: (data?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}

export interface KimiEventClientOptions {
  /** Called for each parsed event received from the WebSocket stream. */
  onEvent: (event: KimiEvent) => void;
  /** Injected WebSocket factory for testing; defaults to the native `ws` client. */
  webSocketFactory?: (url: string, protocols?: string[]) => WebSocketLike;
  /** How to transmit the bearer token. Defaults to `subprotocol`. */
  authMode?: 'subprotocol' | 'query';
  /** Logger for connection lifecycle and parse warnings. Defaults to `console`. */
  logger?: Logger;
}

export interface KimiEventClient {
  start(): void;
  stop(): void;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;

function defaultWebSocketFactory(
  url: string,
  protocols?: string[]
): WebSocketLike {
  return new WebSocket(url, protocols) as unknown as WebSocketLike;
}

/**
 * Creates a resilient WebSocket client that subscribes to the kimi-code event
 * stream.
 *
 * The client authenticates using `authMode`: `subprotocol` sends the bearer
 * token as a WebSocket subprotocol (`bearer.<token>`), and `query` appends
 * `?token=<token>` to the URL. It reconnects with exponential backoff after
 * disconnects until `stop()` is called.
 */
export function createKimiEventClient(
  config: Config,
  options: KimiEventClientOptions
): KimiEventClient {
  const {
    onEvent,
    webSocketFactory = defaultWebSocketFactory,
    authMode = 'subprotocol',
    logger = console,
  } = options;

  let socket: WebSocketLike | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let started = false;

  function connect() {
    if (stopped) return;

    const token = config.kimiBearerToken;
    const baseUrl = `${config.kimiWsUrl}/api/v1/ws`;
    const url =
      authMode === 'query' ? `${baseUrl}?token=${encodeURIComponent(token)}` : baseUrl;
    const protocols = authMode === 'subprotocol' ? [`bearer.${token}`] : undefined;

    const currentSocket = webSocketFactory(url, protocols);
    socket = currentSocket;

    currentSocket.on('open', () => {
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      logger.info({ url: baseUrl }, 'Connected to kimi-code event stream');
    });

    currentSocket.on('message', (raw) => {
      const data = typeof raw === 'string' ? raw : String(raw ?? '');
      try {
        const parsed = JSON.parse(data) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          'type' in parsed &&
          typeof (parsed as { type?: unknown }).type === 'string'
        ) {
          const event: KimiEvent = {
            type: (parsed as { type: string }).type,
            payload: (parsed as { payload?: unknown }).payload,
            sessionId:
              'sessionId' in parsed &&
              typeof (parsed as { sessionId?: unknown }).sessionId === 'string'
                ? (parsed as { sessionId: string }).sessionId
                : undefined,
          };
          try {
            onEvent(event);
          } catch (error) {
            logger.error({ error, eventType: event.type }, 'Event handler threw');
          }
        } else {
          logger.warn({ data }, 'Ignoring kimi-code event with no type');
        }
      } catch (error) {
        logger.warn({ error, data }, 'Failed to parse kimi-code event');
      }
    });

    currentSocket.on('error', (error) => {
      logger.error({ error, url: baseUrl }, 'kimi-code WebSocket error');
    });

    currentSocket.on('close', () => {
      if (socket !== currentSocket) return;
      logger.info({ url: baseUrl }, 'Disconnected from kimi-code event stream');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimeout) return;
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      try {
        connect();
      } catch (error) {
        logger.error({ error }, 'kimi-code WebSocket factory threw');
        scheduleReconnect();
      }
    }, reconnectDelay);
    reconnectDelay = Math.min(
      reconnectDelay * BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY_MS
    );
  }

  return {
    start() {
      if (started) return;
      started = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      stopped = false;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      try {
        connect();
      } catch (error) {
        logger.error({ error }, 'kimi-code WebSocket factory threw');
        scheduleReconnect();
      }
    },
    stop() {
      started = false;
      stopped = true;
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
      }
      socket?.close();
      socket = null;
    },
  };
}
