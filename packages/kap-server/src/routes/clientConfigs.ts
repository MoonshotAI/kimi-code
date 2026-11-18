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
  post(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const clientConfigRequestSchema = z.object({
  name: z.string().min(1),
});

const clientConfigResultSchema = z.object({
  name: z.string(),
  config: z.unknown().nullable(),
});

export function registerClientConfigsRoutes(app: RouteHost, core: Scope): void {
  const sendConfig = async (
    name: string,
    requestId: string,
    reply: { send(payload: unknown): void },
  ): Promise<void> => {
    if (!isRegisteredClientConfig(name)) {
      reply.send(okEnvelope({ name, config: null }, requestId));
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
    reply.send(okEnvelope({ name, config: config ?? null }, requestId));
  };

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/client-configs/{name}',
      params: clientConfigRequestSchema,
      success: { data: clientConfigResultSchema },
      description: 'Fetch a named cloud-controlled client configuration',
      tags: ['config'],
      hide: true,
    },
    (req, reply) => sendConfig(req.params.name, req.id, reply),
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<RouteHost['get']>[2]);

  const postRoute = defineRoute(
    {
      method: 'POST',
      path: '/client_configs',
      body: clientConfigRequestSchema,
      success: { data: clientConfigResultSchema },
      description: 'Fetch a named cloud-controlled client configuration',
      tags: ['config'],
      hide: true,
    },
    (req, reply) => sendConfig(req.body.name, req.id, reply),
  );
  app.post(postRoute.path, postRoute.options, postRoute.handler as Parameters<RouteHost['post']>[2]);
}
