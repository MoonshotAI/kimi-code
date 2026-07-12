/**
 * `WsKlient` — the `/api/v2` scope-entry client over the WebSocket transport.
 *
 * Mirrors `Klient`'s three-level scope entry (`core` / `session` / `agent`),
 * but every Service call rides the shared `WsSocket`, and each scope level
 * also exposes `listen(event, handler)` for the server's event streams
 * (`core` → `events`; `session` → `interactions` / `interactions:resolved`;
 * `agent` → `events`):
 *
 *   const ws = new WsKlient({ url: 'http://127.0.0.1:58627', token });
 *   await ws.core(ISessionIndex).list({});
 *   const sub = ws.session('s1').agent('main').listen('events', (e) => ...);
 *   sub.dispose(); ws.close();
 *
 * Prefer `Klient#ws()` over constructing this directly so HTTP and WS share
 * one configured endpoint.
 */

import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

import { makeProxy } from './proxy.js';
import { WsChannel } from './wsChannel.js';
import {
  WsSocket,
  type WsSocketOptions,
  type WsSocketState,
  type WsSubscription,
} from './wsSocket.js';

export type WsKlientOptions = WsSocketOptions;

export class WsKlient {
  private readonly socket: WsSocket;

  constructor(opts: WsKlientOptions) {
    this.socket = new WsSocket(opts);
  }

  /** Core-scoped Service over WS, e.g. `ws.core(ISessionIndex)`. */
  core<T extends object>(id: ServiceIdentifier<T>): T {
    return makeProxy<T>(new WsChannel({ socket: this.socket, scope: 'core', service: String(id) }));
  }

  /** Session scope entry point. */
  session(sessionId: string): WsSessionClient {
    return new WsSessionClient(this.socket, sessionId);
  }

  /** Subscribe to a core-scoped event stream (e.g. `events`). */
  listen(event: string, handler: (data: unknown) => void): WsSubscription {
    return this.socket.listen('core', event, {}, handler);
  }

  get state(): WsSocketState {
    return this.socket.currentState;
  }

  onDidChangeState(listener: (state: WsSocketState) => void): WsSubscription {
    return this.socket.onDidChangeState(listener);
  }

  onDidListenError(listener: Parameters<WsSocket['onDidListenError']>[0]): WsSubscription {
    return this.socket.onDidListenError(listener);
  }

  close(): void {
    this.socket.close();
  }
}

export class WsSessionClient {
  constructor(
    private readonly socket: WsSocket,
    private readonly sessionId: string,
  ) {}

  /** Session-scoped Service over WS, e.g. `.service(ISessionMetadata)`. */
  service<T extends object>(id: ServiceIdentifier<T>): T {
    return makeProxy<T>(
      new WsChannel({
        socket: this.socket,
        scope: 'session',
        service: String(id),
        sessionId: this.sessionId,
      }),
    );
  }

  /** Subscribe to a session-scoped event stream (e.g. `interactions`). */
  listen(event: string, handler: (data: unknown) => void): WsSubscription {
    return this.socket.listen('session', event, { sessionId: this.sessionId }, handler);
  }

  /** Agent scope entry point. */
  agent(agentId: string): WsAgentClient {
    return new WsAgentClient(this.socket, this.sessionId, agentId);
  }
}

export class WsAgentClient {
  constructor(
    private readonly socket: WsSocket,
    private readonly sessionId: string,
    private readonly agentId: string,
  ) {}

  /** Agent-scoped Service over WS, e.g. `.service(IAgentProfileService)`. */
  service<T extends object>(id: ServiceIdentifier<T>): T {
    return makeProxy<T>(
      new WsChannel({
        socket: this.socket,
        scope: 'agent',
        service: String(id),
        sessionId: this.sessionId,
        agentId: this.agentId,
      }),
    );
  }

  /** Subscribe to an agent-scoped event stream (e.g. `events`). */
  listen(event: string, handler: (data: unknown) => void): WsSubscription {
    return this.socket.listen(
      'agent',
      event,
      { sessionId: this.sessionId, agentId: this.agentId },
      handler,
    );
  }
}
