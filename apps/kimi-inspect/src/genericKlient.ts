/**
 * Generic wire client — a thin adapter over klient's transport primitives,
 * exposing the small `core / session / agent` service-proxy surface plus one
 * directly-owned WebSocket for event streams and connection state.
 *
 * klient's `Klient` facade is contract-driven (typed `global.*` /
 * `session(id).*` methods), but the inspector calls ARBITRARY wire services
 * by channel name — introspecting the server's dynamic `GET /api/v2/channels`
 * list is the whole point of the app — so it composes `HttpChannel` (calls)
 * with a raw `WsSocket` (streams + state) instead.
 */

import type { ScopeRef } from '@moonshot-ai/klient';
import { HttpChannel } from '@moonshot-ai/klient/transports/http/channel';
import { WsSocket } from '@moonshot-ai/klient/transports/ws/wsSocket';
import type {
  WsSocketState,
  WsSubscription,
} from '@moonshot-ai/klient/transports/ws/wsSocket';
import type { ServiceIdentifier } from '@moonshot-ai/agent-core-v2/_base/di/instantiation';

/** A wire Service reference: a DI decorator (stringifies to the wire channel
 * name) or the raw channel name as a string. */
export type ServiceRef<T> = ServiceIdentifier<T> | string;

/** Remote view of a Service contract: every method becomes an async wire call. */
export type ServiceProxy<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

export interface GenericAgentHandle {
  service<T>(id: ServiceRef<T>): ServiceProxy<T>;
}

export interface GenericSessionHandle {
  service<T>(id: ServiceRef<T>): ServiceProxy<T>;
  agent(agentId: string): GenericAgentHandle;
}

export interface GenericWsAgent {
  listen(stream: string, handler: (data: unknown) => void): WsSubscription;
}

export interface GenericWsSession extends GenericWsAgent {
  agent(agentId: string): GenericWsAgent;
}

/** The one owned WebSocket: connection state plus per-scope stream subscriptions. */
export interface GenericWs {
  readonly state: WsSocketState;
  onDidChangeState(listener: (state: WsSocketState) => void): WsSubscription;
  listen(stream: string, handler: (data: unknown) => void): WsSubscription;
  session(sessionId: string): GenericWsSession;
  close(): void;
}

export interface GenericKlient {
  core<T>(id: ServiceRef<T>): ServiceProxy<T>;
  session(sessionId: string): GenericSessionHandle;
  ws(): GenericWs;
}

/** Materialize a proxy whose every property access becomes a wire call. */
function proxy<T>(channel: HttpChannel, scope: ScopeRef, id: ServiceRef<T>): ServiceProxy<T> {
  const name = String(id);
  return new Proxy({} as ServiceProxy<T>, {
    get: (_target, method) => {
      if (typeof method !== 'string') return undefined;
      return (...args: unknown[]) => channel.call(scope, name, method, args);
    },
  });
}

function wsHandle(socket: WsSocket, base: ScopeRef): GenericWsAgent {
  return {
    listen: (stream, handler) =>
      socket.listen(
        base.agentId !== undefined ? 'agent' : base.sessionId !== undefined ? 'session' : 'core',
        stream,
        { sessionId: base.sessionId, agentId: base.agentId },
        handler,
      ),
  };
}

export function createGenericKlient(options: { url: string; token?: string }): GenericKlient {
  const channel = new HttpChannel(options);
  const socket = new WsSocket(options);
  const ws: GenericWs = {
    get state() {
      return socket.currentState;
    },
    onDidChangeState: (listener) => socket.onDidChangeState(listener),
    ...wsHandle(socket, {}),
    session: (sessionId) => ({
      ...wsHandle(socket, { sessionId }),
      agent: (agentId) => wsHandle(socket, { sessionId, agentId }),
    }),
    close: () => {
      socket.close();
    },
  };
  return {
    core: (id) => proxy(channel, {}, id),
    session: (sessionId) => ({
      service: (id) => proxy(channel, { sessionId }, id),
      agent: (agentId) => ({
        service: (id) => proxy(channel, { sessionId, agentId }, id),
      }),
    }),
    ws: () => ws,
  };
}
