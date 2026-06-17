/**
 * `IConnectionRegistry` — flat registry of live WS connections.
 *
 * The registry owns a `Map<connId, WsConnection>` and serves three roles:
 *
 *   1. Lookup by `connId` for broadcast paths and operator commands.
 *   2. Bulk close on shutdown (`closeAll(reason)`) — invoked by
 *      `WSGateway.dispose()` so connections are torn down BEFORE EventService /
 *      peer services, ensuring no service emits into a closed socket.
 *   3. Size accounting (test assertions + observability).
 *
 * Construction-order positioning: registered AFTER `IRestGateway` and BEFORE
 * `ISessionClientsService` / `IEventService`. Under the reverse-construction
 * dispose chain this means the registry tears down LATER than the gateway
 * (which closes all sockets via the registry first), but EARLIER than the
 * peer services / logger. Concretely: `WSGateway.dispose() → registry.closeAll()`
 * then registry.dispose() is a no-op (registry already empty).
 *
 * `dispose()` is defensive: if WSGateway didn't run for any reason (failed
 * mid-boot) we still close any straggler connections so the server process
 * can exit cleanly.
 */

import { createDecorator } from '@moonshot-ai/agent-core';

import type { WsConnection } from '#/ws/connection';

export interface IConnectionRegistry {
  readonly _serviceBrand: undefined;

  /** Insert a freshly-handshaken connection. */
  add(conn: WsConnection): void;
  /** Remove a closed connection. Idempotent. */
  remove(connId: string): void;
  /** Look up by id. */
  get(connId: string): WsConnection | undefined;
  /** Iterate all currently-attached connections. */
  values(): Iterable<WsConnection>;
  /**
   * Close every attached connection with WS close code 1001 (going away) and
   * the given reason. Used by `WSGateway.dispose()` before brokers tear down.
   */
  closeAll(reason?: string): void;
  /** Number of currently-attached connections. */
  size(): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IConnectionRegistry = createDecorator<IConnectionRegistry>('connectionRegistry');
