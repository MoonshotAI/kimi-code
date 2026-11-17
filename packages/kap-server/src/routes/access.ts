import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { getRequestPrincipal } from '../middleware/auth';
import { defineRoute } from '../middleware/defineRoute';
import { isOriginAllowed, originHost } from '../middleware/origin';
import {
  AUTH_RATE_LIMIT_CODE,
  type AuthFailureLimiter,
} from '../middleware/rateLimit';
import { ErrorCode } from '../protocol/error-codes';
import {
  accessMeResponseSchema,
  createAccessRequestBodySchema,
  createAccessRequestResponseSchema,
  exchangeAccessRequestBodySchema,
  exchangeAccessRequestResponseSchema,
  listAccessPrincipalsResponseSchema,
  resolveAccessRequestBodySchema,
  resolveAccessRequestResponseSchema,
  revokeAccessPrincipalResponseSchema,
} from '../protocol/rest-access';
import {
  isValidAccessRequestId,
  type AccessHandshakeManager,
  type AccessRequestView,
  type AccessTokenStore,
} from '../services/auth/accessTokenStore';
import { parseActionSuffix } from './action-suffix';

interface AccessReply {
  code(status: number): AccessReply;
  send(payload: unknown): unknown;
}

interface AccessRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; headers: Record<string, unknown> },
      reply: AccessReply,
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: {
        id: string;
        ip?: string;
        body: unknown;
        params: unknown;
        headers: Record<string, unknown>;
      },
      reply: AccessReply,
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; headers: Record<string, unknown> },
      reply: AccessReply,
    ) => Promise<void> | void,
  ): unknown;
}

export interface RegisterAccessRoutesOptions {
  readonly accessTokenStore: AccessTokenStore;
  readonly handshakeManager?: AccessHandshakeManager;
  readonly allowedOrigins: readonly string[];
  readonly requestLimiter: AuthFailureLimiter;
  readonly exchangeLimiter: AuthFailureLimiter;
  readonly onHandshakePrompt?: (request: AccessRequestView) => void;
}

const principalIdParamSchema = z.object({
  principal_id: z.string().min(1),
});

const accessRequestTailParamSchema = z.object({
  tail: z.string().min(1),
});

function rejectUntrustedBrowserOrigin(
  headers: Record<string, unknown>,
  allowedOrigins: readonly string[],
  requestId: string,
  reply: AccessReply,
): boolean {
  const origin = typeof headers['origin'] === 'string' ? headers['origin'] : undefined;
  if (origin === undefined) return false;
  if (originHost(origin) === undefined && !allowedOrigins.includes(origin)) {
    reply
      .code(403)
      .send(errEnvelope(ErrorCode.ACCESS_FORBIDDEN, 'Origin not allowed', requestId));
    return true;
  }
  const host = typeof headers['host'] === 'string' ? headers['host'] : undefined;
  if (!isOriginAllowed(origin, host, allowedOrigins)) {
    reply
      .code(403)
      .send(errEnvelope(ErrorCode.ACCESS_FORBIDDEN, 'Origin not allowed', requestId));
    return true;
  }
  return false;
}

export function registerAccessRoutes(
  app: AccessRouteHost,
  opts: RegisterAccessRoutesOptions,
): void {
  const meRoute = defineRoute(
    {
      method: 'GET',
      path: '/access/me',
      minRole: 'viewer',
      success: { data: accessMeResponseSchema },
      description: 'Inspect the authenticated caller role and principal identity',
      tags: ['auth'],
      operationId: 'getAccessMe',
    },
    (req, reply) => {
      const principal = getRequestPrincipal(req);
      reply.send(
        okEnvelope(
          {
            role: principal.role,
            principal_id: principal.principalId,
            name: principal.name,
          },
          req.id,
        ),
      );
    },
  );
  app.get(
    meRoute.path,
    meRoute.options,
    meRoute.handler as unknown as Parameters<AccessRouteHost['get']>[2],
  );

  if (opts.handshakeManager === undefined) {
    return;
  }
  const handshakeManager = opts.handshakeManager;

  const listPrincipalsRoute = defineRoute(
    {
      method: 'GET',
      path: '/access/principals',
      minRole: 'owner',
      success: { data: listAccessPrincipalsResponseSchema },
      errors: {
        [ErrorCode.ACCESS_FORBIDDEN]: {},
      },
      description: 'List issued external access token principals',
      tags: ['auth'],
      operationId: 'listAccessPrincipals',
    },
    async (req, reply) => {
      const items = await opts.accessTokenStore.listPrincipals();
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listPrincipalsRoute.path,
    listPrincipalsRoute.options,
    listPrincipalsRoute.handler as unknown as Parameters<AccessRouteHost['get']>[2],
  );

  const revokePrincipalRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/access/principals/{principal_id}',
      minRole: 'owner',
      params: principalIdParamSchema,
      success: { data: revokeAccessPrincipalResponseSchema },
      errors: {
        [ErrorCode.ACCESS_FORBIDDEN]: {},
        [ErrorCode.ACCESS_PRINCIPAL_NOT_FOUND]: {},
      },
      description: 'Revoke an issued external access token principal and close its active connections',
      tags: ['auth'],
      operationId: 'revokeAccessPrincipal',
    },
    async (req, reply) => {
      const principal = await opts.accessTokenStore.revokePrincipal(req.params.principal_id);
      if (principal === undefined) {
        reply.send(
          errEnvelope(
            ErrorCode.ACCESS_PRINCIPAL_NOT_FOUND,
            `access principal not found: ${req.params.principal_id}`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope({ principal }, req.id));
    },
  );
  app.delete(
    revokePrincipalRoute.path,
    revokePrincipalRoute.options,
    revokePrincipalRoute.handler as unknown as Parameters<AccessRouteHost['delete']>[2],
  );

  const createRequestRoute = defineRoute(
    {
      method: 'POST',
      path: '/access/requests',
      minRole: 'public',
      body: createAccessRequestBodySchema,
      success: { data: createAccessRequestResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.ACCESS_FORBIDDEN]: {},
        [AUTH_RATE_LIMIT_CODE]: {},
      },
      description: 'Start a passwordless local access approval request',
      tags: ['auth'],
      operationId: 'createAccessRequest',
    },
    async (req, reply) => {
      const r = reply as unknown as AccessReply;
      const ip = (req as unknown as { ip?: string }).ip ?? 'local';
      if (rejectUntrustedBrowserOrigin(req.headers, opts.allowedOrigins, req.id, r)) {
        return;
      }
      if (opts.requestLimiter.isBanned(ip)) {
        r.code(429).send(errEnvelope(AUTH_RATE_LIMIT_CODE, 'Too many access requests', req.id));
        return;
      }
      opts.requestLimiter.recordFailure(ip);
      const created = await handshakeManager.createRequest({
        clientName: req.body.client_name,
        role: req.body.role,
      });
      opts.onHandshakePrompt?.(created.view);
      r.send(
        okEnvelope(
          {
            request_id: created.request_id,
            device_code: created.device_code,
            user_code: created.user_code,
            expires_at: created.expires_at,
          },
          req.id,
        ),
      );
    },
  );
  app.post(
    createRequestRoute.path,
    createRequestRoute.options,
    createRequestRoute.handler as unknown as Parameters<AccessRouteHost['post']>[2],
  );

  const actionRequestRoute = defineRoute(
    {
      method: 'POST',
      path: '/access/requests/{tail}',
      minRole: 'public',
      params: accessRequestTailParamSchema,
      body: z.union([resolveAccessRequestBodySchema, exchangeAccessRequestBodySchema]),
      success: {
        data: z.union([resolveAccessRequestResponseSchema, exchangeAccessRequestResponseSchema]),
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.ACCESS_FORBIDDEN]: {},
        [ErrorCode.ACCESS_REQUEST_NOT_FOUND]: {},
        [ErrorCode.ACCESS_REQUEST_RESOLVED]: {},
        [ErrorCode.ACCESS_REQUEST_EXPIRED]: {},
        [AUTH_RATE_LIMIT_CODE]: {},
      },
      description: 'Resolve (owner) or exchange (client device_code) an access request',
      tags: ['auth'],
      operationId: 'accessRequestAction',
    },
    async (req, reply) => {
      const r = reply as unknown as AccessReply;
      const parsedTail = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: ['resolve', 'exchange'],
        resourceLabel: 'access request',
      });
      if (parsedTail.kind !== 'action') {
        const message =
          parsedTail.kind === 'invalid'
            ? parsedTail.reason
            : `unsupported action: ${req.params.tail}`;
        r.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      if (!isValidAccessRequestId(parsedTail.id)) {
        r.send(
          errEnvelope(
            ErrorCode.ACCESS_REQUEST_NOT_FOUND,
            `access request not found: ${parsedTail.id}`,
            req.id,
          ),
        );
        return;
      }

      if (parsedTail.action === 'resolve') {
        const principal = getRequestPrincipal(req);
        if (principal.role !== 'owner') {
          r.code(403).send(
            errEnvelope(ErrorCode.ACCESS_FORBIDDEN, 'Insufficient token permissions', req.id),
          );
          return;
        }
        const parsedBody = resolveAccessRequestBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
          r.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid resolve payload', req.id));
          return;
        }
        const outcome = await handshakeManager.resolveRequest(
          parsedTail.id,
          parsedBody.data.decision,
        );
        if (!outcome.ok) {
          if (outcome.reason === 'not_found') {
            r.send(
              errEnvelope(
                ErrorCode.ACCESS_REQUEST_NOT_FOUND,
                `access request not found: ${parsedTail.id}`,
                req.id,
              ),
            );
            return;
          }
          if (outcome.reason === 'expired') {
            r.send(
              errEnvelope(
                ErrorCode.ACCESS_REQUEST_EXPIRED,
                `access request expired: ${parsedTail.id}`,
                req.id,
              ),
            );
            return;
          }
          r.send(
            errEnvelope(
              ErrorCode.ACCESS_REQUEST_RESOLVED,
              `access request already resolved: ${parsedTail.id}`,
              req.id,
            ),
          );
          return;
        }
        r.send(okEnvelope({ request: outcome.request }, req.id));
        return;
      }

      if (rejectUntrustedBrowserOrigin(req.headers, opts.allowedOrigins, req.id, r)) {
        return;
      }
      const ip = (req as unknown as { ip?: string }).ip ?? 'local';
      if (opts.exchangeLimiter.isBanned(ip)) {
        r.code(429).send(errEnvelope(AUTH_RATE_LIMIT_CODE, 'Too many exchange attempts', req.id));
        return;
      }
      const parsedBody = exchangeAccessRequestBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        r.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'invalid exchange payload', req.id));
        return;
      }
      const outcome = await handshakeManager.exchangeRequest(
        parsedTail.id,
        parsedBody.data.device_code,
      );
      if (!outcome.ok) {
        if (outcome.reason === 'invalid_device_code') {
          opts.exchangeLimiter.recordFailure(ip);
          r.code(403).send(errEnvelope(ErrorCode.ACCESS_FORBIDDEN, 'Invalid device_code', req.id));
          return;
        }
        if (outcome.reason === 'already_exchanged') {
          r.send(
            errEnvelope(
              ErrorCode.ACCESS_REQUEST_RESOLVED,
              'access token already exchanged',
              req.id,
            ),
          );
          return;
        }
        r.send(
          errEnvelope(
            ErrorCode.ACCESS_REQUEST_NOT_FOUND,
            `access request not found: ${parsedTail.id}`,
            req.id,
          ),
        );
        return;
      }
      r.send(okEnvelope(outcome.result, req.id));
    },
  );
  app.post(
    actionRequestRoute.path,
    actionRequestRoute.options,
    actionRequestRoute.handler as unknown as Parameters<AccessRouteHost['post']>[2],
  );
}
