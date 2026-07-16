/**
 * `POST /shutdown` route handler.
 *
 * Gracefully terminates the server process. Backed by `IServerShutdownService`
 * so the actual `close()` + `process.exit(0)` lives next to the server
 * bootstrap (and can be overridden in tests). The handler replies before
 * triggering shutdown so callers receive a clean 200 instead of a dropped
 * connection.
 */

import type { IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { IServerShutdownService } from '#/services/gateway';

/**
 * Minimal structural shape for the Fastify instance — just the verb this file
 * calls. Same pattern as `connections.ts` / `prompts.ts` to avoid the strict
 * generic mismatch between Fastify's default instance and the server's
 * pino-typed one.
 */
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

export function registerShutdownRoutes(
  app: ShutdownRouteHost,
  ix: IInstantiationService,
): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/shutdown',
      success: { data: z.object({ ok: z.literal(true) }) },
      description: 'Gracefully shut down the server and terminate its process',
      tags: ['meta'],
    },
    (req, reply) => {
      reply.send(okEnvelope({ ok: true }, req.id));
      // Let the response flush before tearing the server down.
      setImmediate(() => {
        void ix.invokeFunction((a) =>
          a.get(IServerShutdownService).requestShutdown('api'),
        );
      });
    },
  );
  app.post(
    route.path,
    route.options,
    route.handler as Parameters<ShutdownRouteHost['post']>[2],
  );
}
