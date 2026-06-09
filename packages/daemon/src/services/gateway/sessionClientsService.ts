/**
 * `SessionClientsService` — implementation of `ISessionClientsService`.
 */

import { Disposable } from '@moonshot-ai/agent-core';

import { ILogService } from '#/services/logger';
import { ISessionClientsService } from './sessionClients';
import type { WsConnection } from '#/ws/connection';

export class SessionClientsService extends Disposable implements ISessionClientsService {
  readonly _serviceBrand: undefined;

  private readonly _bySession = new Map<string, Set<WsConnection>>();

  /**
   * `@ILogService` is auto-injected by the container. The service does not
   * currently emit log lines (the subscription model is silent by
   * design — service / event-publish call sites do the logging) but the dep is
   * declared so future diagnostic work doesn't need a ctor reshuffle.
   */
  constructor(@ILogService private readonly _logger: ILogService) {
    super();
    void this._logger;
  }

  subscribe(connection: WsConnection, sessionId: string): void {
    let set = this._bySession.get(sessionId);
    if (!set) {
      set = new Set();
      this._bySession.set(sessionId, set);
    }
    set.add(connection);
    this._logger.info(
      {
        sessionId,
        subscriberCount: set.size,
        allSessions: Array.from(this._bySession.keys()),
      },
      '[DBG session-clients.subscribe] added',
    );
  }

  unsubscribe(connection: WsConnection, sessionId: string): void {
    const set = this._bySession.get(sessionId);
    if (!set) return;
    set.delete(connection);
    // Garbage-collect the bucket when empty so `subscriberCount` stays cheap
    // and the map doesn't grow indefinitely with one-off session_ids.
    if (set.size === 0) this._bySession.delete(sessionId);
  }

  getConnections(sessionId: string): Iterable<WsConnection> {
    const set = this._bySession.get(sessionId);
    this._logger.info(
      {
        sessionId,
        found: set ? set.size : 0,
        allSessions: Array.from(this._bySession.keys()),
      },
      '[DBG session-clients.getConnections] lookup',
    );
    if (!set) return EMPTY_ITERABLE;
    return set.values();
  }

  forgetConnection(connection: WsConnection): void {
    // Walk every session bucket and drop the connection. Cheaper than a
    // reverse index (connId → sessionIds) for the expected daemon connection
    // counts.
    for (const [sid, set] of this._bySession) {
      if (set.delete(connection) && set.size === 0) {
        this._bySession.delete(sid);
      }
    }
  }

  subscriberCount(sessionId: string): number {
    return this._bySession.get(sessionId)?.size ?? 0;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._bySession.clear();
    super.dispose();
  }
}

const EMPTY_ITERABLE: Iterable<WsConnection> = Object.freeze({
  [Symbol.iterator]: function* (): Iterator<WsConnection> {
    // empty
  },
});
