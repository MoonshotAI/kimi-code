/**
 * `/oauth/*` REST routes.
 *
 *   POST   /oauth/login   start a device-code flow → OAuthFlowStart
 *   GET    /oauth/login   poll current flow state  → OAuthFlowSnapshot | null
 *   DELETE /oauth/login   cancel pending flow       → { cancelled, status }
 *   POST   /oauth/logout  logout                    → { logged_out, provider }
 *
 * Managed OAuth was a v2 `IOAuthService` (Core scope) capability; that service
 * was retired with the v2 engine. The Rust engine authenticates via config API
 * keys, so these endpoints answer the unsupported / no-op wire shapes so the
 * web UI shows the unmanaged state instead of hanging. Response schemas are
 * the localized `protocol/rest-oauth` copies of the retired v2 oauthProtocol.
 */

import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import {
  managedUsageResultSchema,
  oauthFlowSnapshotSchema,
  oauthFlowStartSchema,
  oauthLoginCancelResponseSchema,
  oauthLoginQuerySchema,
  oauthLoginStartRequestSchema,
  oauthLogoutRequestSchema,
  oauthLogoutResponseSchema,
} from '../protocol/rest-oauth';
import type { RustSessionService } from '../services/rustSession/rustSessionService';

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

const oauthFlowSnapshotOrNullSchema = z.union([
  oauthFlowSnapshotSchema,
  z.null(),
]);

export function registerOAuthRoutes(app: RouteHost, rustSession?: RustSessionService): void {
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
      if (rustSession !== undefined) {
        // Stage 3i: the native engine authenticates via config API keys —
        // managed OAuth device login is a v2-engine capability. Fail loudly
        // so the web UI shows the unsupported state instead of hanging.
        reply.send(
          okEnvelope(
            {
              kind: 'error',
              message: 'managed OAuth login is not available on the native engine; configure a provider API key in /providers instead',
            },
            req.id,
          ),
        );
        return;
      }
      // Unreachable: the v2 IOAuthService branch was retired with the v2
      // engine — the session backend is always the Rust engine.
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
      if (rustSession !== undefined) {
        reply.send(okEnvelope(null, req.id));
        return;
      }
      // Unreachable: the v2 IOAuthService branch was retired with the v2
      // engine — the session backend is always the Rust engine.
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
      if (rustSession !== undefined) {
        reply.send(okEnvelope({ cancelled: true }, req.id));
        return;
      }
      // Unreachable: the v2 IOAuthService branch was retired with the v2
      // engine — the session backend is always the Rust engine.
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
      if (rustSession !== undefined) {
        // Stage 3i: no managed OAuth account on the native engine — logout is
        // a no-op success.
        requestLog(req)?.info({ provider: req.body.provider, action: 'logout' }, 'oauth logout');
        reply.send(okEnvelope({ ok: true }, req.id));
        return;
      }
      // Unreachable: the v2 IOAuthService branch was retired with the v2
      // engine — the session backend is always the Rust engine.
    },
  );
  app.post(
    logoutRoute.path,
    logoutRoute.options,
    logoutRoute.handler as Parameters<RouteHost['post']>[2],
  );

  // GET /oauth/usage — managed-account plan usage (limits + booster wallet) ---
  const usageRoute = defineRoute(
    {
      method: 'GET',
      path: '/oauth/usage',
      querystring: oauthLoginQuerySchema,
      success: { data: managedUsageResultSchema },
      description: 'Get the managed account usage summary',
      tags: ['auth'],
    },
    async (req, reply) => {
      if (rustSession !== undefined) {
        // Stage 3i: the native engine has no managed OAuth account — answer
        // the wire error shape so the UI shows an unmanaged state.
        reply.send(
          okEnvelope(
            {
              kind: 'error',
              message: 'managed account usage is not available on the native engine',
              status: 404,
            },
            req.id,
          ),
        );
        return;
      }
      // Unreachable: the v2 IOAuthService branch was retired with the v2
      // engine — the session backend is always the Rust engine.
    },
  );
  app.get(
    usageRoute.path,
    usageRoute.options,
    usageRoute.handler as Parameters<RouteHost['get']>[2],
  );
}
