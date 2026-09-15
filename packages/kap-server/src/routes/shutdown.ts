import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';

interface ShutdownRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export interface ShutdownRouteOptions {
  readonly onShutdown: () => void;
}

export function registerShutdownRoutes(
  app: ShutdownRouteHost,
  opts: ShutdownRouteOptions,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/shutdown',
      success: { data: z.object({ ok: z.literal(true) }) },
      description: 'Gracefully shut down the server',
      tags: ['meta'],
    },
    (req, reply) => {
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
