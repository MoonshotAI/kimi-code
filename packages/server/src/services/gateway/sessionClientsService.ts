

import { Disposable, ILogService } from '@moonshot-ai/agent-core';

import { ISessionClientsService } from './sessionClients';
import type { WsConnection } from '#/ws/connection';

export class SessionClientsService extends Disposable implements ISessionClientsService {
  readonly _serviceBrand: undefined;

  private readonly _bySession = new Map<string, Set<WsConnection>>();

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
    this._logger.debug(
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

    if (set.size === 0) this._bySession.delete(sessionId);
  }

  getConnections(sessionId: string): Iterable<WsConnection> {
    const set = this._bySession.get(sessionId);
    this._logger.debug(
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
    if (this._store.isDisposed) return;
    this._bySession.clear();
    super.dispose();
  }
}

const EMPTY_ITERABLE: Iterable<WsConnection> = Object.freeze({
  [Symbol.iterator]: function* (): Iterator<WsConnection> {

  },
});
