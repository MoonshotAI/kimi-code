import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import { useHttpRoute } from '../scope';
import { sendOk } from '../route/http';
import { WsRegistryRef } from '../ws-registry';

export function useConnectionsRoutes(prefix: string): void {
  const registry = useInject(WsRegistryRef);
  useHttpRoute({
    id: 'connections',
    method: 'GET',
    path: `${prefix}/connections`,
    handler: (request, response) => {
      const current = registry.value;
      if (current === undefined) {
        throw new Error('ws registry is unavailable (http feature is not installed)');
      }
      const items = current
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
