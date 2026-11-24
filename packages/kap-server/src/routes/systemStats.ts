import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { systemStatsQuerySchema, systemStatsSchema } from '../protocol/rest-system';
import type { SystemStatsCollector } from '../services/systemStats/systemStats';

interface SystemStatsRouteHost {
  get(path: string, options: { preHandler: unknown[]; schema?: Record<string, unknown> }, handler: never): unknown;
}

export function registerSystemStatsRoutes(app: SystemStatsRouteHost, collector: SystemStatsCollector): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/system/stats',
      querystring: systemStatsQuerySchema,
      success: { data: systemStatsSchema },
      description:
        'Report CPU, memory, disk and NVIDIA GPU usage of the computer running this server, within the limits of its container or job. CPU usage covers the time since the previous request; after a pause the request measures for a quarter second first',
      tags: ['meta'],
    },
    async (req, reply) => {
      reply.send(okEnvelope(await collector.collect(req.query.path), req.id));
    },
  );
  app.get(route.path, route.options, route.handler as never);
}
