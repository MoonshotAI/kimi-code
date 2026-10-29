import { IAuthLegacyService, type Scope } from '@moonshot-ai/agent-core-v2';
import { authSummarySchema } from '@moonshot-ai/agent-core-v2/app/authLegacy/authLegacy';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { actorSchema, toWireActor } from '../protocol/actor';

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

  const principalRoute = defineRoute(
    {
      method: 'GET',
      path: '/auth/principal',
      success: { data: actorSchema.nullable() },
      description: 'Get the authenticated user principal, or null when authentication is bypassed',
      tags: ['auth'],
      operationId: 'getAuthPrincipal',
    },
    async (req, reply) => {
      reply.send(okEnvelope(toWireActor(req.authPrincipal) ?? null, req.id));
    },
  );
  app.get(
    principalRoute.path,
    principalRoute.options,
    principalRoute.handler as Parameters<RouteHost['get']>[2],
  );
}
