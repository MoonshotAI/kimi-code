/**
 * `GET /auth` — readiness probe.
 *
 * Single readiness signal that web/IDE clients hit on first paint to decide
 * between onboarding vs. chat UI. Returns 200 + envelope regardless of provider
 * state.
 *
 * The handler is a thin adapter over `IAuthLegacyService`, which projects the
 * v2 provider / model / credential state into the v1 `AuthSummary` wire shape
 * (`{ ready, providers_count, default_model, managed_provider }`). The native
 * `IAuthSummaryService` (which serves `/api/v2`) is intentionally not used here
 * — its `AuthStatus[]` model is the v2 shape, not the v1 contract.
 */

import { IAuthLegacyService, type Scope } from '@moonshot-ai/agent-core-v2';
import { authSummarySchema } from '@moonshot-ai/protocol';

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

export function registerAuthRoute(app: RouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/auth',
      success: { data: authSummarySchema },
      description: 'Get server auth readiness snapshot',
      tags: ['auth'],
    },
    async (req, reply) => {
      const summary = await core.accessor.get(IAuthLegacyService).get();
      reply.send(okEnvelope(summary, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
