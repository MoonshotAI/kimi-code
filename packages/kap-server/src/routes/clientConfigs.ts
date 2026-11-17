import { IBootstrapService, IOAuthService, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  clientConfigsBaseUrl,
  fetchClientConfig,
  isRegisteredClientConfig,
} from '../services/clientConfigs';

interface RouteHost {
  get(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const clientConfigParamsSchema = z.object({
  name: z.string().min(1),
});

const clientConfigResultSchema = z.object({
  name: z.string(),
  config: z.unknown().nullable(),
});

export function registerClientConfigsRoutes(app: RouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/client-configs/{name}',
      params: clientConfigParamsSchema,
      success: { data: clientConfigResultSchema },
      description: 'Fetch a named cloud-controlled client configuration',
      tags: ['config'],
      hide: true,
    },
    async (req, reply) => {
      const { name } = req.params;
      if (!isRegisteredClientConfig(name)) {
        reply.send(okEnvelope({ name, config: null }, req.id));
        return;
      }
      const bootstrap = core.accessor.get(IBootstrapService);
      const config = await fetchClientConfig(
        name,
        clientConfigsBaseUrl(
          bootstrap.getEnv('KIMI_CODE_BASE_URL') ?? process.env['KIMI_CODE_BASE_URL'],
          core.accessor.get(IOAuthService).getRegion(),
        ),
      );
      reply.send(okEnvelope({ name, config: config ?? null }, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
