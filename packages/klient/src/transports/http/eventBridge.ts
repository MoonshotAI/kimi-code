/**
 * Event bridge for the HTTP transport — HTTP has no push channel, so the
 * first event subscription lazily opens one `/api/v2/ws` socket that carries
 * every subscription from then on. The facade never sees this: events arrive
 * exactly as they do over the ipc/memory transports. The socket is created
 * on first use and torn down by `close()`.
 */

import type { EventSourceRef, IDisposable, ScopeRef } from '../../core/channel.js';
import {
  WsSocket,
  type WsLikeCtor,
  type WsScopeIds,
  type WsScopeKind,
} from '../ws/wsSocket.js';

export interface WsEventBridgeOptions {
  /** Server base URL (`http(s)://…`); the ws URL is derived from it. */
  readonly url: string;
  readonly token?: string;
  readonly WebSocketImpl?: WsLikeCtor;
}

function scopeKindOf(scope: ScopeRef): WsScopeKind {
  if (scope.agentId !== undefined) return 'agent';
  if (scope.sessionId !== undefined) return 'session';
  return 'core';
}

function scopeIdsOf(scope: ScopeRef): WsScopeIds {
  return { sessionId: scope.sessionId, agentId: scope.agentId };
}

export class WsEventBridge {
  private readonly socket: WsSocket;

  constructor(options: WsEventBridgeOptions) {
    this.socket = new WsSocket({
      url: options.url,
      token: options.token,
      WebSocketImpl: options.WebSocketImpl,
    });
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    const kind = scopeKindOf(scope);
    const ids = scopeIdsOf(scope);
    if (source.kind === 'stream') {
      // kap-server's eventMap binds service-less listens per scope.
      return this.socket.listen(kind, source.name, ids, handler, undefined, onError);
    }
    return this.socket.listen(kind, source.event, ids, handler, source.service, onError);
  }

  close(): void {
    this.socket.close();
  }
}
