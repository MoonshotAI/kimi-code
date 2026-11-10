import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';

interface ShutdownRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface ShutdownRouteOptions {
  readonly onShutdown: () => void;
  readonly drainIdleSessions: () => Promise<boolean>;
}

const shutdownQuerySchema = z.object({
  if_idle: z.enum(['true', 'false']).optional(),
});

export function registerShutdownRoutes(
  app: ShutdownRouteHost,
  opts: ShutdownRouteOptions,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/shutdown',
      querystring: shutdownQuerySchema,
      success: { data: z.object({ ok: z.boolean() }) },
      description: 'Gracefully shut down the server; with if_idle=true, only when it has no live work (ok: false otherwise)',
      tags: ['meta'],
    },
    async (req, reply) => {
      const query = req.query as z.infer<typeof shutdownQuerySchema>;
      if (query.if_idle === 'true' && !(await opts.drainIdleSessions())) {
        reply.send(okEnvelope({ ok: false }, req.id));
        return;
      }
      requestLog(req)?.info(
        { remoteAddress: (req as unknown as { ip?: string }).ip },
        'shutdown requested',
      );
      reply.send(okEnvelope({ ok: true }, req.id));
      setImmediate(() => opts.onShutdown());
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as Parameters<ShutdownRouteHost['post']>[2],
  );
}
