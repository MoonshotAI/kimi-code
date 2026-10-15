import {
  Error2,
  ErrorCodes,
  IAgentEnvironmentBindingService,
  IEnvironmentService,
  ISessionContext,
  resumeSessionById,
  type EnvironmentBinding,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  runtimeBindingResponseSchema,
  sessionRuntimeParamsSchema,
  switchRuntimeRequestSchema,
  type RuntimeBindingResponse,
} from '../protocol/rest-runtime';
import { ensureMainAgent } from '../transport/mainAgent';
import { sendEnvironmentError } from './environment';

interface RuntimeRouteHost {
  get(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerRuntimeRoutes(app: RuntimeRouteHost, core: Scope): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/runtime',
      params: sessionRuntimeParamsSchema,
      success: { data: runtimeBindingResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'Get the main agent runtime binding',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const { service, workspaceId } = await resolveRuntime(core, req.params.session_id);
      reply.send(okEnvelope(toResponse(service.current, workspaceId), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<RuntimeRouteHost['get']>[2]);

  const switchRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/runtime',
      params: sessionRuntimeParamsSchema,
      body: switchRuntimeRequestSchema,
      success: { data: runtimeBindingResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description: 'Switch the main agent runtime binding',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const { agent, service, workspaceId } = await resolveRuntime(core, req.params.session_id);
        const lease = await agent.accessor.get(IEnvironmentService).acquireWhenReady({ environmentId: req.body.runtime_id });
        try {
          reply.send(okEnvelope(toResponse(service.bind(req.body.runtime_id), workspaceId), req.id));
        } finally {
          lease.dispose();
        }
      } catch (error) {
        if (sendEnvironmentError(reply, req.id, error)) return;
        throw error;
      }
    },
  );
  app.post(switchRoute.path, switchRoute.options, switchRoute.handler as Parameters<RuntimeRouteHost['post']>[2]);
}

async function resolveRuntime(core: Scope, sessionId: string) {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);
  return {
    agent,
    service: agent.accessor.get(IAgentEnvironmentBindingService),
    workspaceId: session.accessor.get(ISessionContext).workspaceId,
  };
}

function toResponse(binding: EnvironmentBinding, workspaceId: string): RuntimeBindingResponse {
  return { workspace_id: workspaceId, runtime_id: binding.environmentId };
}
