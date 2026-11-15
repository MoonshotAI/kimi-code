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
  post(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const clientConfigsRequestSchema = z.object({
  name: z.string(),
});

const clientConfigResultSchema = z.object({
  name: z.string(),
  config: z.unknown().nullable(),
});

export function registerClientConfigsRoutes(app: RouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'POST',
      path: '/client_configs',
      body: clientConfigsRequestSchema,
      success: { data: clientConfigResultSchema },
      description: 'Fetch a named cloud-controlled client configuration',
      tags: ['config'],
    },
    async (req, reply) => {
      const { name } = req.body;
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
  app.post(route.path, route.options, route.handler as Parameters<RouteHost['post']>[2]);
}
