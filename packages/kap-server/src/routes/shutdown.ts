/**
 * `POST /shutdown` route handler.
 *
 * Gracefully terminates the server. The actual `close()` + scope disposal is
 * supplied by `start.ts` via `onShutdown` so it stays next to the bootstrap
 * (and remains overridable in tests). The handler replies before triggering
 * shutdown so callers receive a clean 200 instead of a dropped connection.
 */

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
      // Let the response flush before tearing the server down.
      setImmediate(() => opts.onShutdown());
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as Parameters<ShutdownRouteHost['post']>[2],
  );
}
