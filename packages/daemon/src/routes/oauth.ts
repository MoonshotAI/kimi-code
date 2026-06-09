/**
 * `/v1/oauth/*` REST routes.
 *
 *   POST   /v1/oauth/login   start a device-code flow → OAuthFlowStart
 *   GET    /v1/oauth/login   poll current flow state  → OAuthFlowSnapshot | null
 *   DELETE /v1/oauth/login   cancel pending flow       → { cancelled, status }
 *   POST   /v1/oauth/logout  logout                    → { logged_out, provider }
 *
 * **Polling contract**: the frontend opens `verification_uri_complete` in a
 * browser tab, then polls `GET /v1/oauth/login` at the `interval` seconds
 * returned in the start response. When `status` flips to `'authenticated'`,
 * stop polling and hit `GET /v1/auth` to see `ready: true`.
 *
 * **No bare flow_id in URL**: only one flow is in-flight per provider. The
 * frontend has the flow_id from the start response — it uses it client-side
 * to detect "the flow I started got superseded" (matching the snapshot's
 * flow_id against its own captured value).
 */

import {
  oauthFlowSnapshotSchema,
  oauthFlowStartSchema,
  oauthLoginCancelResponseSchema,
  oauthLoginQuerySchema,
  oauthLoginStartRequestSchema,
  oauthLogoutRequestSchema,
  oauthLogoutResponseSchema,
} from '@moonshot-ai/protocol';
import { IOAuthService } from '@moonshot-ai/services';
import type { IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

/**
 * Structural Fastify subset — same shape as `meta.ts` / `auth.ts` so the
 * generic-mismatch with the daemon's pino-typed FastifyInstance doesn't
 * bleed into this file.
 */
interface RouteHost {
  get(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
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
  delete(
    path: string,
    options: { preHandler?: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

/**
 * `GET /v1/oauth/login` returns either a snapshot or `null` (no flow yet).
 * Wrap in a nullable z.object so the generated OpenAPI knows about both.
 */
const oauthFlowSnapshotOrNullSchema = z.union([
  oauthFlowSnapshotSchema,
  z.null(),
]);

export function registerOAuthRoutes(app: RouteHost, ix: IInstantiationService): void {
  // POST /oauth/login — start device flow ----------------------------------
  const loginStartRoute = defineRoute(
    {
      method: 'POST',
      path: '/oauth/login',
      body: oauthLoginStartRequestSchema,
      success: { data: oauthFlowStartSchema },
      description: 'Start an OAuth device-code flow',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await ix.invokeFunction((a) =>
        a.get(IOAuthService).startLogin(req.body.provider),
      );
      reply.send(okEnvelope(result, req.id));
    },
  );

  app.post(
    loginStartRoute.path,
    loginStartRoute.options,
    loginStartRoute.handler as Parameters<RouteHost['post']>[2],
  );

  // GET /oauth/login — poll current flow state -----------------------------
  const loginPollRoute = defineRoute(
    {
      method: 'GET',
      path: '/oauth/login',
      querystring: oauthLoginQuerySchema,
      success: { data: oauthFlowSnapshotOrNullSchema },
      description: 'Poll the current OAuth device-code flow',
      tags: ['auth'],
    },
    async (req, reply) => {
      const snapshot = ix.invokeFunction((a) =>
        a.get(IOAuthService).getFlow(req.query.provider),
      );
      reply.send(okEnvelope(snapshot ?? null, req.id));
    },
  );

  app.get(
    loginPollRoute.path,
    loginPollRoute.options,
    loginPollRoute.handler as Parameters<RouteHost['get']>[2],
  );

  // DELETE /oauth/login — cancel pending flow ------------------------------
  const loginCancelRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/oauth/login',
      querystring: oauthLoginQuerySchema,
      success: { data: oauthLoginCancelResponseSchema },
      description: 'Cancel the current OAuth device-code flow',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await ix.invokeFunction((a) =>
        a.get(IOAuthService).cancelLogin(req.query.provider),
      );
      reply.send(okEnvelope(result, req.id));
    },
  );

  app.delete(
    loginCancelRoute.path,
    loginCancelRoute.options,
    loginCancelRoute.handler as Parameters<RouteHost['delete']>[2],
  );

  // POST /oauth/logout -----------------------------------------------------
  const logoutRoute = defineRoute(
    {
      method: 'POST',
      path: '/oauth/logout',
      body: oauthLogoutRequestSchema,
      success: { data: oauthLogoutResponseSchema },
      description: 'Logout the managed OAuth provider',
      tags: ['auth'],
    },
    async (req, reply) => {
      const result = await ix.invokeFunction((a) =>
        a.get(IOAuthService).logout(req.body.provider),
      );
      reply.send(okEnvelope(result, req.id));
    },
  );

  app.post(
    logoutRoute.path,
    logoutRoute.options,
    logoutRoute.handler as Parameters<RouteHost['post']>[2],
  );
}
