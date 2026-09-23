import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { metaResponseSchema } from '../protocol/rest-meta';
import type { MetaFeature, MetaResponse } from '../protocol/rest-meta';

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

export interface MetaRouteOptions {
  readonly serverVersion: string;
  readonly serverId: string;
  readonly startedAt: string;
  readonly dangerousBypassAuth: boolean;
  readonly webTitle?: string;
  readonly getExperimentalFlags: () => Record<string, boolean> | Promise<Record<string, boolean>>;
  readonly getFeatures: () => MetaFeature[] | Promise<MetaFeature[]>;
  readonly multiSession: () => boolean;
}

const MULTI_SESSION_CAPABILITIES = Object.freeze({
  auto_resume: true as const,
  batch_resume: true as const,
  live_list: true as const,
  idle_reaper: true as const,
});

export function registerMetaRoute(app: RouteHost, opts: MetaRouteOptions): void {
  const staticData = Object.freeze({
    server_version: opts.serverVersion,
    capabilities: Object.freeze({
      websocket: true as const,
      file_upload: true as const,
      fs_query: true as const,
      mcp: true as const,
      tasks: true as const,
      terminal: true as const,
    }),
    server_id: opts.serverId,
    started_at: opts.startedAt,
    open_in_apps: [],
    dangerous_bypass_auth: opts.dangerousBypassAuth,
    backend: 'v2' as const,
    web_title: opts.webTitle,
  });

  const route = defineRoute(
    {
      method: 'GET',
      path: '/meta',
      success: { data: metaResponseSchema },
      description: 'Get server metadata',
      tags: ['meta'],
    },
    async (req, reply) => {
      const experimentalFlags = await opts.getExperimentalFlags();
      const data: MetaResponse = {
        ...staticData,
        capabilities: opts.multiSession()
          ? { ...staticData.capabilities, multi_session: MULTI_SESSION_CAPABILITIES }
          : staticData.capabilities,
        experimental_flags: experimentalFlags,
        features: await opts.getFeatures(),
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
