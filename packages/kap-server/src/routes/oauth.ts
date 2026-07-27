/**
 * `/oauth/*` REST routes.
 *
 *   POST   /oauth/login   start a device-code flow → OAuthFlowStart
 *   GET    /oauth/login   poll current flow state  → OAuthFlowSnapshot | null
 *   DELETE /oauth/login   cancel pending flow       → { cancelled, status }
 *   POST   /oauth/logout  logout                    → { logged_out, provider }
 *
 * Backed by the v2 `IOAuthService` (Core scope), which already returns the
 * protocol wire types, so the handlers only swap the v1 accessor
 * (`ix.invokeFunction`) for the v2 one (`core.accessor.get`).
 */

import { IOAuthService, type Scope } from '@moonshot-ai/agent-core-v2';
import {
  managedUsageResultSchema,
  oauthFlowSnapshotSchema,
  oauthFlowStartSchema,
  oauthLoginCancelResponseSchema,
  oauthLogoutResponseSchema,
  type ManagedUsageResult,
  type UsageRow,
} from '@moonshot-ai/agent-core-v2/app/auth/oauthProtocol';
import { z } from 'zod';

import { okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import {
  oauthLoginQuerySchema,
  oauthLoginStartRequestSchema,
  oauthLogoutRequestSchema,
} from '../protocol/rest-oauth';

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

export function registerOAuthRoutes(app: RouteHost, core: Scope): void {
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
      const result = await core.accessor.get(IOAuthService).startLogin(req.body.provider);
      requestLog(req)?.info({ provider: req.body.provider, action: 'login' }, 'oauth login started');
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
      const snapshot = core.accessor.get(IOAuthService).getFlow(req.query.provider);
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
      const result = await core.accessor.get(IOAuthService).cancelLogin(req.query.provider);
      requestLog(req)?.info(
        { provider: req.query.provider, action: 'cancel_login' },
        'oauth login cancelled',
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
      const result = await core.accessor.get(IOAuthService).logout(req.body.provider);
      requestLog(req)?.info({ provider: req.body.provider, action: 'logout' }, 'oauth logout');
      reply.send(okEnvelope(result, req.id));
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
      const result = await core.accessor.get(IOAuthService).getManagedUsage(req.query.provider);
      reply.send(okEnvelope(toWireUsage(result), req.id));
    },
  );
  app.get(
    usageRoute.path,
    usageRoute.options,
    usageRoute.handler as Parameters<RouteHost['get']>[2],
  );
}

/** Domain (camelCase) → wire (snake_case) mapping for the usage payload. */
function toWireUsage(result: ManagedUsageDomainResult): ManagedUsageResult {
  if (result.kind === 'error') {
    return { kind: 'error', message: result.message, status: result.status };
  }
  return {
    kind: 'ok',
    summary: result.summary === null ? null : toWireUsageRow(result.summary),
    limits: result.limits.map(toWireUsageRow),
    extra_usage:
      result.extraUsage === null
        ? null
        : {
            balance_cents: result.extraUsage.balanceCents,
            total_cents: result.extraUsage.totalCents,
            monthly_charge_limit_enabled: result.extraUsage.monthlyChargeLimitEnabled,
            monthly_charge_limit_cents: result.extraUsage.monthlyChargeLimitCents,
            monthly_used_cents: result.extraUsage.monthlyUsedCents,
            currency: result.extraUsage.currency,
          },
  };
}

type ManagedUsageDomainResult = Awaited<ReturnType<IOAuthService['getManagedUsage']>>;
type DomainUsageRow = { label: string; used: number; limit: number; resetHint?: string };

function toWireUsageRow(row: DomainUsageRow): UsageRow {
  return { label: row.label, used: row.used, limit: row.limit, reset_hint: row.resetHint };
}
