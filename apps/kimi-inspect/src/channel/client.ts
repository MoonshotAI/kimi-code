/**
 * Inspect client — the app's `/api/v1/debug` entry point, in the old-klient
 * VS Code `ProxyChannel` model: a three-level scope entry (`core` /
 * `session` / `agent`) whose every Service handle is a
 * `makeProxy`-materialized typed proxy over a service-bound HTTP channel.
 *
 *   const client = createInspectClient({ url: 'http://127.0.0.1:58627' });
 *   await client.core(ISessionIndex).list({});
 *   await client.session('s1').service(ISessionMetadata).read();
 *   await client.session('s1').agent('main').service(IAgentRPCService).cancel({});
 *
 * The `agent-core-v2` service token is the whole key: its type parameter `T`
 * types the returned proxy, and its decorator id (`String(id)`) is the channel
 * name in the URL. Calls ride HTTP (`ProxyChannel`). There is no event
 * transport: the v2 socket (`/api/v2/ws`) that used to carry Service `onXxx`
 * emitters and scope event streams was removed server-side, so the UI reads
 * Service state on demand. (The transcript's own `/api/v1/ws` delta channel
 * lives in `src/transcript/` and is unrelated to this client.)
 */

import type { ServiceProxy, ServiceRef } from './channel';
import { makeProxy } from './proxy';
import { ProxyChannel } from './proxyChannel';

/** The dev server's whitelist-free debug surface (`--debug-endpoints` + loopback). */
export const DEBUG_RPC_BASE = '/api/v1/debug' as const;

export interface InspectAgentHandle {
  service<T extends object>(id: ServiceRef<T>): ServiceProxy<T>;
}

export interface InspectSessionHandle extends InspectAgentHandle {
  agent(agentId: string): InspectAgentHandle;
}

export interface InspectClient {
  /** Absolute server base URL, e.g. `http://127.0.0.1:58627`. */
  readonly baseUrl: string;
  /** Bearer token in use, when any. */
  readonly token?: string;
  core<T extends object>(id: ServiceRef<T>): ServiceProxy<T>;
  session(sessionId: string): InspectSessionHandle;
}

export interface InspectClientOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly url: string;
  /** Optional bearer token. */
  readonly token?: string;
}

export function createInspectClient(options: InspectClientOptions): InspectClient {
  const url = options.url.replace(/\/$/, '');

  /** Materialize a typed proxy for one Service on one scope binding. */
  function proxy<T extends object>(scopePath: string, id: ServiceRef<T>): ServiceProxy<T> {
    const service = String(id);
    return makeProxy<T>(
      new ProxyChannel({
        baseUrl: `${url}${DEBUG_RPC_BASE}${scopePath}/${service}`,
        token: options.token,
      }),
    );
  }

  return {
    baseUrl: url,
    token: options.token,
    core: (id) => proxy('', id),
    session: (sessionId) => {
      const scopePath = `/session/${encodeURIComponent(sessionId)}`;
      return {
        service: (id) => proxy(scopePath, id),
        agent: (agentId) => ({
          service: (subId) => proxy(`${scopePath}/agent/${encodeURIComponent(agentId)}`, subId),
        }),
      };
    },
  };
}
