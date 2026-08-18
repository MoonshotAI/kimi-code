import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { metaResponseSchema } from '../protocol/rest-meta';
import type { MetaResponse } from '../protocol/rest-meta';

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
  /**
   * Whether the server was started with `--dangerous-bypass-auth`. Surfaced so
   * the web UI can skip the token prompt and connect without a credential.
   */
  readonly dangerousBypassAuth: boolean;
  /**
   * Custom browser tab title for this instance (the CLI's `--web-title`).
   * Surfaced as `web_title` in the `/meta` payload; instance-level and frozen
   * at boot, so it joins the frozen static fields. Omitted when unset.
   */
  readonly webTitle?: string;
  /**
   * Resolves the effective experimental-flag map (flag id → enabled) at
   * request time. Backed by `IFlagService.snapshot()` in production; tests may
   * stub it. May return a promise — the handler awaits it, so flag state
   * always reflects the fully loaded config (never pre-load defaults).
   */
  readonly getExperimentalFlags: () => Record<string, boolean> | Promise<Record<string, boolean>>;
}

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
      const data: MetaResponse = {
        ...staticData,
        experimental_flags: await opts.getExperimentalFlags(),
      };
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
