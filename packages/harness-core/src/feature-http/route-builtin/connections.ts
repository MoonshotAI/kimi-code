import { useInject } from '@moonshot-ai/agent-core';

import { useHttpRoute } from '../feature';
import { sendOk } from '../route/http';
import { WsRegistryRef } from '../ws-registry';

export function useConnectionsRoutes(prefix: string): void {
  useHttpRoute({
    id: 'connections',
    method: 'GET',
    path: `${prefix}/connections`,
    handler: (request, response) => {
      const registry = useInject(WsRegistryRef).value;
      if (registry === undefined) {
        throw new Error('ws registry is unavailable (http feature is not installed)');
      }
      const items = registry
        .list()
        .map((connection) => ({
          id: connection.id,
          connected_at: connection.connectedAt,
          subscriptions: [...connection.subscriptions],
          agents: connection.agents,
          protocol: connection.protocol,
          has_client_hello: connection.hasClientHello,
        }));
      sendOk(request, response, { items });
    },
  });
}
