import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { getRequestPrincipal } from '../middleware/auth';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  accessMeResponseSchema,
  listAccessPrincipalsResponseSchema,
  revokeAccessPrincipalResponseSchema,
} from '../protocol/rest-access';
import type { AccessTokenStore } from '../services/auth/accessTokenStore';

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
  readonly persistEnabled?: boolean;
}

const principalIdParamSchema = z.object({
  principal_id: z.string().min(1),
});

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

  if (opts.persistEnabled === false) {
    return;
  }

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
}
