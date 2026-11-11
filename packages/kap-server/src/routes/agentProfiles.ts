import {
  IUserAgentProfileManagementService,
  UserAgentProfileError,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  agentProfileMutationResultSchema,
  agentProfileParamsSchema,
  createAgentProfileRequestSchema,
  deleteAgentProfileQuerySchema,
  deleteAgentProfileResultSchema,
  getAgentProfileResponseSchema,
  listAgentProfilesResponseSchema,
  refreshAgentProfilesRequestSchema,
  refreshAgentProfilesResultSchema,
  updateAgentProfileRequestSchema,
} from '../protocol/rest-agent-profile';

interface AgentProfilesRouteHost {
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
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  put(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const domainErrors = {
  [ErrorCode.VALIDATION_FAILED]: {},
  [ErrorCode.AGENT_PROFILE_NOT_FOUND]: {},
  [ErrorCode.AGENT_PROFILE_ALREADY_EXISTS]: {},
  [ErrorCode.AGENT_PROFILE_STALE]: {},
};

export function registerAgentProfilesRoutes(app: AgentProfilesRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/agent-profiles',
      success: { data: listAgentProfilesResponseSchema },
      errors: {},
      description: 'List user-level custom agent profiles',
      tags: ['agent-profiles'],
      operationId: 'listAgentProfiles',
    },
    async (req, reply) => {
      const result = await core.accessor.get(IUserAgentProfileManagementService).list();
      reply.send(okEnvelope(result, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const refreshRoute = defineRoute(
    {
      method: 'POST',
      path: '/agent-profiles:refresh',
      body: refreshAgentProfilesRequestSchema,
      success: { data: refreshAgentProfilesResultSchema },
      errors: {},
      description: 'Reload user-level agent profiles in materialized workspaces',
      tags: ['agent-profiles'],
      operationId: 'refreshAgentProfiles',
    },
    async (req, reply) => {
      const result = await core.accessor.get(IUserAgentProfileManagementService).refresh();
      reply.send(okEnvelope({ refreshed: true as const, refresh_error: result.refreshError }, req.id));
    },
  );
  app.post(refreshRoute.path, refreshRoute.options, refreshRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/agent-profiles',
      body: createAgentProfileRequestSchema,
      success: { data: agentProfileMutationResultSchema },
      errors: domainErrors,
      description: 'Create a user-level custom agent profile',
      tags: ['agent-profiles'],
      operationId: 'createAgentProfile',
    },
    async (req, reply) => {
      try {
        const result = await core.accessor.get(IUserAgentProfileManagementService).create(req.body);
        reply.send(okEnvelope({ agent: result.agent, refresh_error: result.refreshError }, req.id));
      } catch (error) {
        if (sendMappedError(reply, req.id, error)) return;
        throw error;
      }
    },
  );
  app.post(createRoute.path, createRoute.options, createRoute.handler as Parameters<AgentProfilesRouteHost['post']>[2]);

  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/agent-profiles/{name}',
      params: agentProfileParamsSchema,
      success: { data: getAgentProfileResponseSchema },
      errors: domainErrors,
      description: 'Get a user-level custom agent profile for editing',
      tags: ['agent-profiles'],
      operationId: 'getAgentProfile',
    },
    async (req, reply) => {
      try {
        const agent = await core.accessor.get(IUserAgentProfileManagementService).getProfile(req.params.name);
        reply.send(okEnvelope({ agent }, req.id));
      } catch (error) {
        if (sendMappedError(reply, req.id, error)) return;
        throw error;
      }
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<AgentProfilesRouteHost['get']>[2]);

  const updateRoute = defineRoute(
    {
      method: 'PUT',
      path: '/agent-profiles/{name}',
      params: agentProfileParamsSchema,
      body: updateAgentProfileRequestSchema,
      success: { data: agentProfileMutationResultSchema },
      errors: domainErrors,
      description: 'Update or rename a user-level custom agent profile',
      tags: ['agent-profiles'],
      operationId: 'updateAgentProfile',
    },
    async (req, reply) => {
      try {
        const result = await core.accessor.get(IUserAgentProfileManagementService).update(req.params.name, {
          newName: req.body.new_name,
          description: req.body.description,
          prompt: req.body.prompt,
          etag: req.body.etag,
        });
        reply.send(okEnvelope({ agent: result.agent, refresh_error: result.refreshError }, req.id));
      } catch (error) {
        if (sendMappedError(reply, req.id, error)) return;
        throw error;
      }
    },
  );
  app.put(updateRoute.path, updateRoute.options, updateRoute.handler as Parameters<AgentProfilesRouteHost['put']>[2]);

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/agent-profiles/{name}',
      params: agentProfileParamsSchema,
      querystring: deleteAgentProfileQuerySchema,
      success: { data: deleteAgentProfileResultSchema },
      errors: domainErrors,
      description: 'Delete a user-level custom agent profile',
      tags: ['agent-profiles'],
      operationId: 'deleteAgentProfile',
    },
    async (req, reply) => {
      try {
        const result = await core.accessor.get(IUserAgentProfileManagementService).delete(
          req.params.name,
          req.query.etag,
        );
        reply.send(okEnvelope({ deleted: true as const, refresh_error: result.refreshError }, req.id));
      } catch (error) {
        if (sendMappedError(reply, req.id, error)) return;
        throw error;
      }
    },
  );
  app.delete(deleteRoute.path, deleteRoute.options, deleteRoute.handler as Parameters<AgentProfilesRouteHost['delete']>[2]);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  error: unknown,
): boolean {
  if (!(error instanceof UserAgentProfileError)) return false;
  const code = error.kind === 'not_found'
    ? ErrorCode.AGENT_PROFILE_NOT_FOUND
    : error.kind === 'already_exists'
      ? ErrorCode.AGENT_PROFILE_ALREADY_EXISTS
      : error.kind === 'stale'
        ? ErrorCode.AGENT_PROFILE_STALE
        : ErrorCode.VALIDATION_FAILED;
  reply.send(errEnvelope(code, error.message, requestId));
  return true;
}
