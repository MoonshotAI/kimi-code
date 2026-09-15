import {
  Error2,
  ErrorCodes,
  IAgentRuntimeBindingService,
  resumeSessionById,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { RuntimeError } from '@moonshot-ai/agent-core-v2/runtime/runtimeRegistry';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  runtimeBindingResponseSchema,
  sessionRuntimeParamsSchema,
  switchRuntimeRequestSchema,
  type RuntimeBindingResponse,
} from '../protocol/rest-runtime';
import { ensureMainAgent } from '../transport/mainAgent';

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
      const service = await resolveRuntime(core, req.params.session_id);
      reply.send(okEnvelope(toResponse(service.get()), req.id));
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
        [ErrorCode.RUNTIME_NOT_FOUND]: {},
        [ErrorCode.RUNTIME_UNAVAILABLE]: {},
      },
      description: 'Switch the main agent runtime binding',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const service = await resolveRuntime(core, req.params.session_id);
        reply.send(okEnvelope(toResponse(service.switch(req.body.runtime_id)), req.id));
      } catch (error) {
        if (error instanceof RuntimeError) {
          const code = error.code === 'runtime.not_found'
            ? ErrorCode.RUNTIME_NOT_FOUND
            : ErrorCode.RUNTIME_UNAVAILABLE;
          reply.send(errEnvelope(code, error.message, req.id));
          return;
        }
        throw error;
      }
    },
  );
  app.post(switchRoute.path, switchRoute.options, switchRoute.handler as Parameters<RuntimeRouteHost['post']>[2]);
}

async function resolveRuntime(core: Scope, sessionId: string): Promise<IAgentRuntimeBindingService> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);
  return agent.accessor.get(IAgentRuntimeBindingService);
}

function toResponse(binding: { workspaceId: string; runtimeId: string }): RuntimeBindingResponse {
  return { workspace_id: binding.workspaceId, runtime_id: binding.runtimeId };
}
