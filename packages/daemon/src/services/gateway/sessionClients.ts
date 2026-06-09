/**
 * `ISessionClientsService` — `sessionId → Set<WsConnection>` reverse index.
 *
 * `IConnectionRegistry` indexes connections by `connId` (1→1 by socket).
 * `ISessionClientsService` indexes them by `sessionId` (1→N by subscription)
 * so `EventService.publish(event)` can fan out to all live subscribers in
 * O(1) lookup + O(k) send (k = subscribers of that session).
 *
 * Why a separate service (not a method on the registry): the registry
 * doesn't know about subscriptions — those are application-level state, not
 * connection-level. Keeping them separate also lets WS subscribe/unsubscribe
 * mutations skip touching the connection map.
 *
 * Construction order: registered AFTER `IConnectionRegistry` and BEFORE
 * `IEventService` (the event service consumes this service). Disposes (in reverse)
 * BEFORE the connection registry — no special teardown needed because the
 * connection registry has its own `closeAll()` path.
 *
 * **Idempotency**: `subscribe(conn, sid)` is idempotent — adding the same
 * connection twice is a no-op (Set semantics). `unsubscribe` likewise.
 * `forgetConnection` drops the connection from EVERY session's set.
 */

import { Disposable, createDecorator } from '@moonshot-ai/agent-core';

import { ILogService } from '#/services/logger';
import type { WsConnection } from '#/ws/connection';

export interface ISessionClientsService {
  readonly _serviceBrand: undefined;

  /** Add `connection` as a subscriber to `sessionId`. Idempotent. */
  subscribe(connection: WsConnection, sessionId: string): void;
  /** Remove a single (connection, sessionId) subscription. Idempotent. */
  unsubscribe(connection: WsConnection, sessionId: string): void;
  /** Iterate all connections subscribed to `sessionId`. */
  getConnections(sessionId: string): Iterable<WsConnection>;
  /** Remove `connection` from every session it was subscribed to. */
  forgetConnection(connection: WsConnection): void;
  /** Test helper / observability: count of subscribers for a session. */
  subscriberCount(sessionId: string): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const ISessionClientsService = createDecorator<ISessionClientsService>(
  'sessionClientsService',
);


