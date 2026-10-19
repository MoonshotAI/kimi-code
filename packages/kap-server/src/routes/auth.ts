import { IAuthLegacyService, type Scope } from '@moonshot-ai/agent-core-v2';
import { authSummarySchema } from '@moonshot-ai/agent-core-v2/app/authLegacy/authLegacy';

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
