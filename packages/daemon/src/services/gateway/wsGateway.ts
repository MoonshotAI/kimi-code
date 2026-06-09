/**
 * `IWSGateway` — WebSocket gateway.
 *
 * Owns a `ws.WebSocketServer` in `noServer` mode and attaches an `'upgrade'`
 * handler to the Fastify-exposed raw `http.Server`. WS path is `/api/v1/ws`
 * (WS.md §1.1). On upgrade we instantiate a `WsConnection`, register it in
 * `IConnectionRegistry`, and let the connection drive its own handshake +
 * heartbeat.
 *
 * **Construction order**:
 *   ILogService → IRestGateway → IConnectionRegistry → ISessionClientsService
 *     → IEventService → IApprovalService → IQuestionService
 *     → IWSGateway   ← here, constructed LATE
 *     → ICoreProcessService
 *
 * Why late: dispose runs in REVERSE construction order. So `WSGateway.dispose()`
 * runs EARLY at shutdown, closing all WS connections via the registry BEFORE
 * EventService / peer services tear down. If we constructed WSGateway earlier,
 * a peer service's `.dispose()` could try to emit on a still-attached socket
 * whose owner is already gone.
 *
 * Why `noServer` mode (not `port:`): Fastify already owns the HTTP server.
 * We share it — every WS handshake passes through Fastify's listener, gets
 * intercepted by our `'upgrade'` handler, and only `/api/v1/ws` paths are
 * upgraded; other paths get an immediate `socket.destroy()` (defensive).
 *
 * `dispose()` is reverse-order safe:
 *   1. `registry.closeAll()` — sends WS code 1001 (going away) to each socket.
 *   2. `wss.close()` — stops accepting new upgrades.
 *   3. Detaches the `'upgrade'` listener from `app.server`.
 *
 * Anti-corruption: no SDK imports. WS schemas come from
 * `@moonshot-ai/protocol`.
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';
import { WebSocketServer, type WebSocket } from 'ws';

import { IConnectionRegistry } from './connectionRegistry';
import { ILogService } from '#/services/logger';
import { IRestGateway } from './restGateway';
import { ISessionClientsService } from './sessionClients';
import { WsConnection, type AbortHandler, type FsWatchHandler } from '#/ws/connection';

/** WS endpoint path. WS.md §1.1. */
export const WS_PATH = '/api/v1/ws';

export interface IWSGateway {
  readonly _serviceBrand: undefined;

  /** Number of currently-attached WS connections. */
  readonly size: number;
  /**
   * Attach an abort handler so future WS connections can dispatch `abort`
   * control messages through it. Has no effect on already-attached
   * connections (they captured their handler at construction).
   */
  setAbortHandler(handler: AbortHandler): void;
  /**
   * Attach an fs-watch handler so future WS connections can dispatch
   * `subscribe.watch_fs` / `watch_fs_add` / `watch_fs_remove`
   * through it. Like `setAbortHandler`, only affects connections opened
   * AFTER the call; in production we wire it once at startup before the
   * REST listener accepts traffic, so this is a non-issue.
   */
  setFsWatchHandler(handler: FsWatchHandler): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSGateway = createDecorator<IWSGateway>('wsGateway');

export interface WSGatewayOptions {
  /**
   * Override the default ping interval (30_000ms) for tests so the test can
   * observe a `ping` without sleeping 30s.
   */
  pingIntervalMs?: number;
  /** Override the default pong deadline (10_000ms). */
  pongTimeoutMs?: number;
}


