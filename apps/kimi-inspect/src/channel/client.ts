/**
 * Inspect client — the app's `/api/v2` entry point, in the old-klient VS Code
 * `ProxyChannel` model: a three-level scope entry (`core` / `session` /
 * `agent`) whose every Service handle is a `makeProxy`-materialized typed
 * proxy over a service-bound channel, plus the one shared `/api/v2/ws` socket
 * for scope event streams and connection state.
 *
 *   const client = createInspectClient({ url: 'http://127.0.0.1:58627' });
 *   await client.core(ISessionIndex).list({});
 *   await client.session('s1').service(ISessionMetadata).read();
 *   await client.session('s1').agent('main').service(IAgentRPCService).getModel();
 *
 * The `agent-core-v2` service token is the whole key: its type parameter `T`
 * types the returned proxy, and its decorator id (`String(id)`) is the channel
 * name in the URL. Calls ride HTTP (`ProxyChannel`); the proxy's `onXxx`
 * emitter events and the scope streams (`events` / `interactions` /
 * `interactions:resolved`) ride the one shared `WsSocket`.
 */

import type { ServiceProxy, ServiceRef } from './channel';
import { makeProxy } from './proxy';
import { ProxyChannel } from './proxyChannel';
import { WsChannel } from './wsChannel';
import {
  WsSocket,
  type WsScopeIds,
  type WsScopeKind,
  type WsSocketState,
  type WsSubscription,
} from './wsSocket';

export interface InspectAgentHandle {
  service<T extends object>(id: ServiceRef<T>): ServiceProxy<T>;
}

export interface InspectSessionHandle extends InspectAgentHandle {
  agent(agentId: string): InspectAgentHandle;
}

export interface InspectWsAgent {
  listen(stream: string, handler: (data: unknown) => void): WsSubscription;
}

export interface InspectWsSession extends InspectWsAgent {
  agent(agentId: string): InspectWsAgent;
}

/** The one owned WebSocket: connection state plus per-scope stream subscriptions. */
export interface InspectWs {
  readonly state: WsSocketState;
  onDidChangeState(listener: (state: WsSocketState) => void): WsSubscription;
  listen(stream: string, handler: (data: unknown) => void): WsSubscription;
  session(sessionId: string): InspectWsSession;
  close(): void;
}

export interface InspectClient {
  /** Absolute server base URL, e.g. `http://127.0.0.1:58627`. */
  readonly baseUrl: string;
  /** Bearer token in use, when any. */
  readonly token?: string;
  /** RPC base path for calls and `/channels`: `/api/v1/debug` on dev servers
   * (whitelist-free), `/api/v2` otherwise. Resolved by the connection probe. */
  readonly rpcBasePath: string;
  core<T extends object>(id: ServiceRef<T>): ServiceProxy<T>;
  session(sessionId: string): InspectSessionHandle;
  ws(): InspectWs;
}

export interface InspectClientOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly url: string;
  /** Optional bearer token. */
  readonly token?: string;
  /** RPC base path for service calls + `/channels` introspection. Default
   * `/api/v2`; the connection layer probes and passes `/api/v1/debug` when
   * the server mounts the dev debug surface (`--debug-endpoints`). */
  readonly rpcBasePath?: string;
}

export function createInspectClient(options: InspectClientOptions): InspectClient {
  const url = options.url.replace(/\/$/, '');
  const rpcBasePath = options.rpcBasePath ?? '/api/v2';
  const socket = new WsSocket(options);

  /** Materialize a typed proxy for one Service on one scope binding. */
  function proxy<T extends object>(
    scopePath: string,
    scope: WsScopeKind,
    ids: WsScopeIds,
    id: ServiceRef<T>,
  ): ServiceProxy<T> {
    const service = String(id);
    return makeProxy<T>(
      new ProxyChannel(
        { baseUrl: `${url}${rpcBasePath}${scopePath}/${service}`, token: options.token },
        () => new WsChannel({ socket, scope, service, ...ids }),
      ),
    );
  }

  function wsListen(ids: WsScopeIds): InspectWsAgent {
    return {
      listen: (stream, handler) =>
        socket.listen(
          ids.agentId !== undefined ? 'agent' : ids.sessionId !== undefined ? 'session' : 'core',
          stream,
          ids,
          handler,
        ),
    };
  }

  const ws: InspectWs = {
    get state() {
      return socket.currentState;
    },
    onDidChangeState: (listener) => socket.onDidChangeState(listener),
    ...wsListen({}),
    session: (sessionId) => ({
      ...wsListen({ sessionId }),
      agent: (agentId) => wsListen({ sessionId, agentId }),
    }),
    close: () => {
      socket.close();
    },
  };

  return {
    baseUrl: url,
    token: options.token,
    rpcBasePath,
    core: (id) => proxy('', 'core', {}, id),
    session: (sessionId) => {
      const scopePath = `/session/${encodeURIComponent(sessionId)}`;
      return {
        service: (id) => proxy(scopePath, 'session', { sessionId }, id),
        agent: (agentId) => ({
          service: (subId) =>
            proxy(`${scopePath}/agent/${encodeURIComponent(agentId)}`, 'agent', {
              sessionId,
              agentId,
            }, subId),
        }),
      };
    },
    ws: () => ws,
  };
}
