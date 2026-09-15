import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { type IConnectionRegistry } from '../transport/ws/connectionRegistry';
import { connectionsListResponseSchema } from '../protocol/rest-connection';

interface ConnectionsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerConnectionsRoutes(
  app: ConnectionsRouteHost,
  registry: IConnectionRegistry,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/connections',
      success: { data: connectionsListResponseSchema },
      description: 'List active WebSocket clients connected to the server',
      tags: ['connections'],
    },
    (req, reply) => {
      const connections = Array.from(registry.values())
        .map((conn) => ({
          id: conn.id,
          connected_at: conn.connectedAt,
          remote_address: conn.remoteAddress,
          user_agent: conn.userAgent,
          has_client_hello: conn.hasClientHello,
          subscriptions: [...conn.subscriptionSessionIds],
        }))
        .sort((a, b) => a.connected_at.localeCompare(b.connected_at));
      reply.send(okEnvelope({ connections }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<ConnectionsRouteHost['get']>[2],
  );
}
