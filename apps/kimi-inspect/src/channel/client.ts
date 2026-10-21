import type { ServiceProxy, ServiceRef } from './channel';
import { makeProxy } from './proxy';
import { ProxyChannel } from './proxyChannel';

export const DEBUG_RPC_BASE = '/api/v1/debug' as const;

export interface InspectAgentHandle {
  service<T extends object>(id: ServiceRef<T>): ServiceProxy<T>;
}

export interface InspectSessionHandle extends InspectAgentHandle {
  agent(agentId: string): InspectAgentHandle;
}

export interface InspectClient {
  readonly baseUrl: string;
  readonly token?: string;
  core<T extends object>(id: ServiceRef<T>): ServiceProxy<T>;
  session(sessionId: string): InspectSessionHandle;
}

export interface InspectClientOptions {
  readonly url: string;
  readonly token?: string;
}

export function createInspectClient(options: InspectClientOptions): InspectClient {
  const url = options.url.replace(/\/$/, '');

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
