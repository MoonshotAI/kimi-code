/**
 * `GET /connections` route handler.
 *
 * Lists the WebSocket clients currently attached to `/api/v1/ws`. Backed by the
 * in-memory `IConnectionRegistry` — the server's only stateful client concept.
 * REST is stateless and agent sessions are a separate resource, so "active
 * clients" here means live WS connections.
 *
 * Read-only and effectively infallible: it only snapshots the registry map.
 */

import { connectionsListResponseSchema } from '@moonshot-ai/protocol';
import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { IConnectionRegistry } from '#/services/gateway';

/**
 * Minimal structural shape for the Fastify instance — just the verb this file
 * calls. Same pattern as `meta.ts` / `sessions.ts` to avoid the strict generic
 * mismatch between Fastify's default instance and the server's pino-typed one.
 */
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
  ix: IInstantiationService,
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
      const registry = ix.invokeFunction((a) => a.get(IConnectionRegistry));
      const connections = Array.from(registry.values())
        .map((conn) => ({
          id: conn.id,
          connected_at: conn.connectedAt,
          remote_address: conn.remoteAddress,
          user_agent: conn.userAgent,
          has_client_hello: conn.hasClientHello,
          subscriptions: Array.from(conn.subscriptions),
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
