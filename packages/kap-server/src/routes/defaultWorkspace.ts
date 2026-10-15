import {
  DefaultWorkspaceUnavailableError,
  IDefaultWorkspace,
  type DefaultWorkspaceStatus,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  defaultWorkspaceStatusSchema,
  defaultWorkspaceUnavailableDataSchema,
  updateDefaultWorkspaceRequestSchema,
  type DefaultWorkspaceStatusWire,
} from '../protocol/default-workspace';
import { ErrorCode } from '../protocol/error-codes';

interface DefaultWorkspaceRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerDefaultWorkspaceRoutes(app: DefaultWorkspaceRouteHost, core: Scope): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/default-workspace',
      success: { data: defaultWorkspaceStatusSchema },
      description: 'Get the default workspace location',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const status = await core.accessor.get(IDefaultWorkspace).status();
      reply.send(okEnvelope(toWireStatus(status), req.id));
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<DefaultWorkspaceRouteHost['get']>[2],
  );

  const updateRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/default-workspace',
      body: updateDefaultWorkspaceRequestSchema,
      success: { data: defaultWorkspaceStatusSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.DEFAULT_WORKSPACE_UNAVAILABLE]: {
          dataSchema: defaultWorkspaceUnavailableDataSchema,
        },
      },
      description: 'Set a custom default workspace location, or null to use the system default',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      let status: DefaultWorkspaceStatus;
      try {
        status = await core.accessor
          .get(IDefaultWorkspace)
          .setCustomPath(req.body.path ?? undefined);
      } catch (error) {
        const envelope = defaultWorkspaceErrorEnvelope(error, req.id);
        if (envelope === undefined) throw error;
        reply.send(envelope);
        return;
      }
      reply.send(okEnvelope(toWireStatus(status), req.id));
    },
  );
  app.patch(
    updateRoute.path,
    updateRoute.options,
    updateRoute.handler as Parameters<DefaultWorkspaceRouteHost['patch']>[2],
  );
}

export function defaultWorkspaceErrorEnvelope(
  error: unknown,
  requestId: string,
):
  | {
      code: number;
      msg: string;
      data: { path: string | null; reason: string };
      request_id: string;
    }
  | undefined {
  if (!(error instanceof DefaultWorkspaceUnavailableError)) return undefined;
  return {
    code: ErrorCode.DEFAULT_WORKSPACE_UNAVAILABLE,
    msg: error.message,
    data: { path: error.details.path ?? null, reason: error.details.reason },
    request_id: requestId,
  };
}

function toWireStatus(status: DefaultWorkspaceStatus): DefaultWorkspaceStatusWire {
  return {
    path: status.path ?? null,
    custom_path: status.customPath ?? null,
    exists: status.exists,
  };
}
