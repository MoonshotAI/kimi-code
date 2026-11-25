import KAP_SPEC_MARKDOWN from '../../docs/kap.md?raw';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { metaResponseSchema } from '../protocol/rest-meta';
import type { MetaFeature, MetaResponse } from '../protocol/rest-meta';
import { DEVICE_API_LEVEL } from '../services/devices/deviceProtocol';

interface RouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string },
      reply: { type?(contentType: string): unknown; send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export interface MetaRouteOptions {
  readonly serverVersion: string;
  readonly product?: string;
  readonly deviceId: string;
  readonly serverId: string;
  readonly startedAt: string;
  readonly homeDir: string;
  readonly dangerousBypassAuth: boolean;
  readonly webTitle?: string;
  readonly systemUpgrade?: boolean;
  readonly getExperimentalFlags: () => Record<string, boolean> | Promise<Record<string, boolean>>;
  readonly getFeatures: () => MetaFeature[] | Promise<MetaFeature[]>;
}

export const KIMI_AGENT_PROTOCOL_VERSION = '1.0.0';

export function registerMetaRoute(app: RouteHost, opts: MetaRouteOptions): void {
  const product = opts.product !== undefined && opts.product.length > 0 ? opts.product : undefined;
  const staticData = Object.freeze({
    kimi_agent_protocol_version: KIMI_AGENT_PROTOCOL_VERSION,
    server_version: opts.serverVersion,
    product,
    device_id: opts.deviceId,
    device_api_level: DEVICE_API_LEVEL,
    capabilities: Object.freeze({
      websocket: true as const,
      file_upload: true as const,
      feedback: true as const,
      fs_query: true as const,
      mcp: true as const,
      tasks: true as const,
      interactions_list: true as const,
      session_wait: true as const,
      agent_close: true as const,
      session_continue: true as const,
      system_upgrade: opts.systemUpgrade === true ? (true as const) : undefined,
      system_stats: true as const,
    }),
    server_id: opts.serverId,
    started_at: opts.startedAt,
    home_dir: opts.homeDir,
    open_in_apps: [],
    dangerous_bypass_auth: opts.dangerousBypassAuth,
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
      const data: MetaResponse = {
        ...staticData,
        experimental_flags: await opts.getExperimentalFlags(),
        features: await opts.getFeatures(),
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);

  const kapSpecBytes = Buffer.from(KAP_SPEC_MARKDOWN, 'utf8');
  app.get(
    '/kap.md',
    {
      schema: {
        description: 'Get the built-in Kimi Agent Protocol (KAP) Markdown specification matching this server version',
        tags: ['meta'],
        operationId: 'getKapSpec',
      },
    },
    async (_req, reply) => {
      reply.type?.('text/markdown; charset=utf-8');
      reply.send(kapSpecBytes);
    },
  );
}
