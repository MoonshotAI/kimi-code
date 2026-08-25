import { CapabilityErrors, ICapabilityService, isError2, type Scope } from '@moonshot-ai/agent-core-v2';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  capabilityIdParamSchema,
  capabilityStatusSchema,
  listCapabilitiesResponseSchema,
} from '../protocol/rest-capability';
import { parseActionSuffix } from './action-suffix';

interface CapabilitiesRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const capabilityTailParamsSchema = z.object({
  tail: z.string().min(1),
});

export function registerCapabilitiesRoutes(app: CapabilitiesRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/capabilities',
      success: { data: listCapabilitiesResponseSchema },
      errors: {},
      description: 'List built-in capabilities with layered readiness status',
      tags: ['capabilities'],
      operationId: 'listCapabilities',
    },
    async (req, reply) => {
      const capabilities = await core.accessor.get(ICapabilityService).listCapabilities();
      reply.send(okEnvelope({ capabilities }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<CapabilitiesRouteHost['get']>[2],
  );

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/capabilities/{capability_id}',
      params: capabilityIdParamSchema,
      success: { data: capabilityStatusSchema },
      errors: {
        [ErrorCode.CAPABILITY_NOT_FOUND]: {},
      },
      description: 'Get one capability readiness status',
      tags: ['capabilities'],
      operationId: 'getCapability',
    },
    async (req, reply) => {
      try {
        const capability = await core.accessor
          .get(ICapabilityService)
          .getCapability(req.params.capability_id);
        reply.send(okEnvelope(capability, req.id));
      } catch (error) {
        reply.send(mapCapabilityError(error, req.id));
      }
    },
  );
  app.get(
    getRoute.path,
    getRoute.options,
    getRoute.handler as Parameters<CapabilitiesRouteHost['get']>[2],
  );

  const installRoute = defineRoute(
    {
      method: 'POST',
      path: '/capabilities/{tail}',
      params: capabilityTailParamsSchema,
      success: { data: capabilityStatusSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.CAPABILITY_NOT_FOUND]: {},
        [ErrorCode.CAPABILITY_UNSUPPORTED]: {},
        [ErrorCode.CAPABILITY_INSTALL_IN_PROGRESS]: {},
      },
      description: 'Start an idempotent capability install (poll GET for progress)',
      tags: ['capabilities'],
      operationId: 'installCapability',
    },
    async (req, reply) => {
      const parsed = parseActionSuffix({
        tail: req.params.tail,
        allowedActions: ['install'],
        resourceLabel: 'capability',
      });
      if (parsed.kind !== 'action') {
        const message = parsed.kind === 'invalid' ? parsed.reason : `unsupported action: ${req.params.tail}`;
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, message, req.id));
        return;
      }
      try {
        const capability = await core.accessor
          .get(ICapabilityService)
          .installCapability(parsed.id);
        reply.send(okEnvelope(capability, req.id));
      } catch (error) {
        reply.send(mapCapabilityError(error, req.id));
      }
    },
  );
  app.post(
    installRoute.path,
    installRoute.options,
    installRoute.handler as Parameters<CapabilitiesRouteHost['post']>[2],
  );
}

const CAPABILITY_ERROR_MAP: Readonly<Record<string, ErrorCode>> = {
  [CapabilityErrors.codes.CAPABILITY_NOT_FOUND]: ErrorCode.CAPABILITY_NOT_FOUND,
  [CapabilityErrors.codes.CAPABILITY_UNSUPPORTED]: ErrorCode.CAPABILITY_UNSUPPORTED,
  [CapabilityErrors.codes.CAPABILITY_INSTALL_IN_PROGRESS]: ErrorCode.CAPABILITY_INSTALL_IN_PROGRESS,
};

function mapCapabilityError(error: unknown, requestId: string) {
  const mapped = isError2(error) ? CAPABILITY_ERROR_MAP[error.code] : undefined;
  if (mapped !== undefined && isError2(error)) {
    return errEnvelope(mapped, error.message, requestId, error.stack);
  }
  return errEnvelope(
    ErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
    requestId,
    error instanceof Error ? error.stack : undefined,
  );
}
