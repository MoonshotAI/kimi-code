/**
 * `GET /meta` route handler.
 *
 * Returns the server's `server_version`, declared `capabilities` literal map,
 * a per-process `server_id` (ULID minted at boot — reset on every restart so
 * clients can detect a server restart and resync), and `started_at` ISO time.
 *
 * **No DI**: this route doesn't touch services — it's pure server-self info.
 * The `MetaRouteOptions` payload
 * is provided by `start.ts` at registration time and frozen for the server's
 * lifetime.
 *
 * **Wire shape**: matches `metaResponseSchema` (REST.md §3.1) exactly. The
 * envelope wrap is `okEnvelope(data, req.id)` — `req.id` is the bare 26-char
 * ULID set by Fastify's `genReqId` via `resolveRequestId`.
 */

import { metaResponseSchema } from '@moonshot-ai/protocol';

import { getAvailableOpenInApps } from '../lib/fileLaunch';
import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import type { MetaResponse } from '@moonshot-ai/protocol';

/**
 * Minimal structural shape for the Fastify instance — just the verbs this
 * file calls. Avoids the strict generic mismatch between Fastify's default
 * `FastifyInstance` and the server's pino-typed variant
 * (`FastifyInstance<…, ServerLogger>`), same pattern as
 * `error-handler.ts:ErrorHandlerHost` and `rest-gateway.ts:FastifyLike`.
 */
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
  /** Per-process ULID. Minted once at boot in `start.ts`. */
  readonly serverId: string;
  /** ISO 8601 UTC timestamp the server went live at. */
  readonly startedAt: string;
}

export function registerMetaRoute(app: RouteHost, opts: MetaRouteOptions): void {
  // Freeze a single response object — this endpoint's payload never changes
  // for the server's lifetime (capabilities are first-version literal `true`s).
  const data: MetaResponse = Object.freeze({
    server_version: opts.serverVersion,
    capabilities: Object.freeze({
      websocket: true as const,
      file_upload: true as const,
      fs_query: true as const,
      mcp: true as const,
      background_tasks: true as const,
      terminal: true as const,
    }),
    server_id: opts.serverId,
    started_at: opts.startedAt,
    open_in_apps: [...getAvailableOpenInApps()],
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
      reply.send(okEnvelope(data, req.id));
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<RouteHost['get']>[2]);
}
