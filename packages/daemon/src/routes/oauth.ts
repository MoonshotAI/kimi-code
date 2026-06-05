/**
 * `/v1/oauth/*` REST routes (P2.7).
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
 * **No bare flow_id in URL**: PLAN D6.4 says one in-flight per provider. The
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
import type {
  OAuthLoginStartRequest,
  OAuthLoginQuery,
  OAuthLogoutRequest,
} from '@moonshot-ai/protocol';
import type { IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';

import { okEnvelope } from '../envelope.js';
import { buildRouteSchema } from '../middleware/schema.js';
import { validateBody, validateQuery } from '../middleware/validate.js';

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
  app.post(
    '/oauth/login',
    {
      preHandler: [validateBody(oauthLoginStartRequestSchema)],
      schema: buildRouteSchema({
        description: 'Start an OAuth device-code flow',
        tags: ['auth'],
        body: oauthLoginStartRequestSchema,
        response: { 200: oauthFlowStartSchema },
      }),
    },
    async (req, reply) => {
      const body = req.body as OAuthLoginStartRequest;
      const result = await ix.invokeFunction((a) =>
        a.get(IOAuthService).startLogin(body.provider),
      );
      reply.send(okEnvelope(result, req.id));
    },
  );

  // GET /oauth/login — poll current flow state -----------------------------
  app.get(
    '/oauth/login',
    {
      preHandler: [validateQuery(oauthLoginQuerySchema)],
      schema: buildRouteSchema({
        description: 'Poll the current OAuth device-code flow',
        tags: ['auth'],
        querystring: oauthLoginQuerySchema,
        response: { 200: oauthFlowSnapshotOrNullSchema },
      }),
    },
    async (req, reply) => {
      const query = req.query as OAuthLoginQuery;
      const snapshot = ix.invokeFunction((a) =>
        a.get(IOAuthService).getFlow(query.provider),
      );
      reply.send(okEnvelope(snapshot ?? null, req.id));
    },
  );

  // DELETE /oauth/login — cancel pending flow ------------------------------
  app.delete(
    '/oauth/login',
    {
      preHandler: [validateQuery(oauthLoginQuerySchema)],
      schema: buildRouteSchema({
        description: 'Cancel the current OAuth device-code flow',
        tags: ['auth'],
        querystring: oauthLoginQuerySchema,
        response: { 200: oauthLoginCancelResponseSchema },
      }),
    },
    async (req, reply) => {
      const query = req.query as OAuthLoginQuery;
      const result = await ix.invokeFunction((a) =>
        a.get(IOAuthService).cancelLogin(query.provider),
      );
      reply.send(okEnvelope(result, req.id));
    },
  );

  // POST /oauth/logout -----------------------------------------------------
  app.post(
    '/oauth/logout',
    {
      preHandler: [validateBody(oauthLogoutRequestSchema)],
      schema: buildRouteSchema({
        description: 'Logout the managed OAuth provider',
        tags: ['auth'],
        body: oauthLogoutRequestSchema,
        response: { 200: oauthLogoutResponseSchema },
      }),
    },
    async (req, reply) => {
      const body = req.body as OAuthLogoutRequest;
      const result = await ix.invokeFunction((a) =>
        a.get(IOAuthService).logout(body.provider),
      );
      reply.send(okEnvelope(result, req.id));
    },
  );
}
