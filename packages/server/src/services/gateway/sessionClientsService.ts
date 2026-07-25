

import { Disposable, ILogService } from '@moonshot-ai/agent-core';

import { ISessionClientsService } from './sessionClients';
import type { WsConnection } from '#/ws/connection';

export class SessionClientsService extends Disposable implements ISessionClientsService {
  readonly _serviceBrand: undefined;

  private readonly _bySession = new Map<string, Set<WsConnection>>();
  /** Reverse index: connectionId → subscribed sessionIds. Enables O(m) cleanup on disconnect. */
  private readonly _byConnection = new Map<string, Set<string>>();

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
    // Maintain reverse index for fast O(m) disconnect cleanup.
    let connSessions = this._byConnection.get(connection.id);
    if (!connSessions) {
      connSessions = new Set();
      this._byConnection.set(connection.id, connSessions);
    }
    connSessions.add(sessionId);
    this._logger.debug(
      {
        sessionId,
        subscriberCount: set.size,
      },
      '[DBG session-clients.subscribe] added',
    );
  }

  unsubscribe(connection: WsConnection, sessionId: string): void {
    const set = this._bySession.get(sessionId);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this._bySession.delete(sessionId);
    // Clean up reverse index
    const connSessions = this._byConnection.get(connection.id);
    if (connSessions) {
      connSessions.delete(sessionId);
      if (connSessions.size === 0) this._byConnection.delete(connection.id);
    }
  }

  getConnections(sessionId: string): Iterable<WsConnection> {
    const set = this._bySession.get(sessionId);
    this._logger.debug(
      {
        sessionId,
        found: set ? set.size : 0,
      },
      '[DBG session-clients.getConnections] lookup',
    );
    if (!set) return EMPTY_ITERABLE;
    return set.values();
  }

  forgetConnection(connection: WsConnection): void {
    const connSessions = this._byConnection.get(connection.id);
    if (!connSessions) return;
    for (const sid of connSessions) {
      const set = this._bySession.get(sid);
      if (set) {
        set.delete(connection);
        if (set.size === 0) this._bySession.delete(sid);
      }
    }
    this._byConnection.delete(connection.id);
  }

  subscriberCount(sessionId: string): number {
    return this._bySession.get(sessionId)?.size ?? 0;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    this._bySession.clear();
    this._byConnection.clear();
    super.dispose();
  }
}

const EMPTY_ITERABLE: Iterable<WsConnection> = Object.freeze({
  [Symbol.iterator]: function* (): Iterator<WsConnection> {

  },
});
