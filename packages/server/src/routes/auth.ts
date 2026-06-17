/**
 * `GET /v1/auth` — readiness probe (REST.md §3).
 *
 * Single权威 readiness signal that web/IDE clients hit on first paint to
 * decide between onboarding vs. chat UI. Returns 200 + envelope regardless
 * of provider state — failure modes for downstream entries (prompt submit,
 * model PATCH) carry `40110/40111/40112/40113` codes; this probe never
 * fails on auth.
 *
 * **No DI for input** — the route just resolves `IAuthSummaryService` from
 * the accessor and forwards the snapshot. Same structural shape as
 * `meta.ts`'s `RouteHost`.
 *
 * **Anti-corruption**: no SDK package imports; `IAuthSummaryService` is the
 * services-package façade.
 */

import { authSummarySchema } from '@moonshot-ai/protocol';
import { IAuthSummaryService, type IInstantiationService } from '@moonshot-ai/agent-core';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerAuthRoute(app: RouteHost, ix: IInstantiationService): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/auth',
      success: { data: authSummarySchema },
      description: 'Get server auth readiness snapshot',
      tags: ['auth'],
    },
    async (req, reply) => {
      const summary = await ix.invokeFunction((a) =>
        a.get(IAuthSummaryService).get(),
      );
      reply.send(okEnvelope(summary, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
