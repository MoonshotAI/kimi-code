import {
  Error2,
  ErrorCodes,
  IAgentEnvironmentBindingService,
  IBootstrapService,
  IHostFileSystem,
  IEnvironmentDeclarationService,
  ISessionContext,
  IEnvironmentService,
  environmentEntryInfo,
  resumeSessionById,
  EnvironmentError,
  isError2,
  type IAgentScopeHandle,
  type RemoteEnvironmentEntry,
  type EnvironmentBinding,
  type EnvironmentGenerationSnapshot,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import { HandshakeError, RemoteSession, connectWithGuidance, toLauncherSpec } from '@moonshot-ai/agent-core-v2/remote';
import { RemoteEnvironmentEntrySchema } from '@moonshot-ai/agent-core-v2/remote/declaration/remoteEnvironmentDeclaration';
import { readSshConfigHosts } from '@moonshot-ai/agent-core-v2/remote/declaration/sshConfigHosts';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  environmentBindingResponseSchema,
  sessionEnvironmentParamsSchema,
  sessionEnvironmentsResponseSchema,
  type EnvironmentBindingResponse,
  type SessionEnvironmentEntry,
  type SessionEnvironmentsResponse,
} from '../protocol/rest-environment';
import { ensureMainAgent } from '../transport/mainAgent';

interface EnvironmentRouteHost {
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
      req: { id: string; body: unknown },
      reply: { send(payload: unknown): void },
    ) => Promise<void> | void,
  ): unknown;
}

const sshConfigHostsResponseSchema = z.object({
  config_path: z.string(),
  exists: z.boolean(),
  hosts: z.array(z.object({
    alias: z.string(),
    host_name: z.string().optional(),
    user: z.string().optional(),
    port: z.number().int().optional(),
  })),
});

const testEnvironmentRequestSchema = z.object({
  definition: RemoteEnvironmentEntrySchema,
  path: z.string().min(1).optional(),
}).strict();

export function registerEnvironmentRoutes(app: EnvironmentRouteHost, core: Scope, clientVersion?: string): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/environment',
      params: sessionEnvironmentParamsSchema,
      success: { data: environmentBindingResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'Get the main agent environment binding',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const agent = await resolveEnvironmentAgent(core, req.params.session_id);
        reply.send(okEnvelope(toResponse(agent.accessor.get(IAgentEnvironmentBindingService).current, agent.accessor.get(ISessionContext).workspaceId), req.id));
      } catch (error) {
        sendEnvironmentRouteError(reply, req.id, error);
      }
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<EnvironmentRouteHost['get']>[2]);

  const listAllRoute = defineRoute(
    {
      method: 'GET',
      path: '/environments',
      success: { data: sessionEnvironmentsResponseSchema },
      description: 'List configured execution environments and their current status',
      tags: ['environments'],
    },
    async (req, reply) => {
      const declarations = await resolveDeclarations(core);
      const payload: SessionEnvironmentsResponse = {
        environments: core.accessor.get(IEnvironmentService).snapshot().environments.map((environment) =>
          toEntry(environment, declarations.get(environment.environmentId)),
        ),
      };
      reply.send(okEnvelope(payload, req.id));
    },
  );
  app.get(listAllRoute.path, listAllRoute.options, listAllRoute.handler as Parameters<EnvironmentRouteHost['get']>[2]);

  const sshHostsRoute = defineRoute(
    {
      method: 'GET',
      path: '/environments::ssh-hosts',
      success: { data: sshConfigHostsResponseSchema },
      description: 'List concrete Host aliases declared in the local ~/.ssh/config, following Include directives',
      tags: ['environments'],
    },
    async (req, reply) => {
      const result = await readSshConfigHosts(core.accessor.get(IHostFileSystem), core.accessor.get(IBootstrapService).osHomeDir);
      reply.send(okEnvelope({
        config_path: result.configPath,
        exists: result.exists,
        hosts: result.hosts.map((host) => ({
          alias: host.alias,
          ...(host.hostName !== undefined ? { host_name: host.hostName } : {}),
          ...(host.user !== undefined ? { user: host.user } : {}),
          ...(host.port !== undefined ? { port: host.port } : {}),
        })),
      }, req.id));
    },
  );
  app.get(sshHostsRoute.path, sshHostsRoute.options, sshHostsRoute.handler as Parameters<EnvironmentRouteHost['get']>[2]);

  const testRoute = defineRoute(
    {
      method: 'POST',
      path: '/environments::test',
      body: testEnvironmentRequestSchema,
      success: { data: z.object({ connected: z.literal(true) }) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Test a draft remote environment without changing configured environments',
      tags: ['environments'],
    },
    async (req, reply) => {
      let session: RemoteSession | undefined;
      try {
        const launcher = toLauncherSpec(req.body.definition);
        session = await connectWithGuidance(
          (spec) => RemoteSession.connect({ environmentId: 'connection-test', launcher: spec, clientVersion }),
          { launcher },
        );
        const target = req.body.path ?? session.host.homeDir;
        const path = await session.fs.realpath(target);
        await session.fs.readdir(path);
        reply.send(okEnvelope({ connected: true as const }, req.id));
      } catch (error) {
        if (!sendEnvironmentError(reply, req.id, error)) {
          reply.send(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id));
        }
      } finally {
        await session?.dispose();
      }
    },
  );
  app.post(testRoute.path, testRoute.options, testRoute.handler as Parameters<EnvironmentRouteHost['post']>[2]);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/environments',
      params: sessionEnvironmentParamsSchema,
      success: { data: sessionEnvironmentsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.WIRE_VERSION_TOO_LOW]: {},
      },
      description: 'List the environments available to the session',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const session = await resumeSessionById(core.accessor, req.params.session_id);
        if (session === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${req.params.session_id} does not exist`);
        }
        const declarations = await resolveDeclarations(core);
        const payload: SessionEnvironmentsResponse = {
          environments: core.accessor.get(IEnvironmentService).snapshot().environments.map((environment) =>
            toEntry(environment, declarations.get(environment.environmentId)),
          ),
        };
        reply.send(okEnvelope(payload, req.id));
      } catch (error) {
        sendEnvironmentRouteError(reply, req.id, error);
      }
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<EnvironmentRouteHost['get']>[2]);
}

async function resolveEnvironmentAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

async function resolveDeclarations(core: Scope): Promise<ReadonlyMap<string, RemoteEnvironmentEntry>> {
  const declarations = await core.accessor.get(IEnvironmentDeclarationService).declarations();
  return new Map((declarations?.entries ?? []).map((declaration) => [declaration.id, declaration.entry]));
}

function toEntry(environment: EnvironmentGenerationSnapshot, entry: RemoteEnvironmentEntry | undefined): SessionEnvironmentEntry {
  const info = environmentEntryInfo(environment, entry);
  return {
    environment_id: info.environmentId,
    type: info.type,
    status: info.status,
    connect_error: info.connectError,
  };
}

function toResponse(binding: EnvironmentBinding, workspaceId: string): EnvironmentBindingResponse {
  return { workspace_id: workspaceId, environment_id: binding.environmentId, cwd: binding.cwd };
}

function sendEnvironmentRouteError(
  reply: { send(payload: unknown): void },
  requestId: string,
  error: unknown,
): void {
  if (sendEnvironmentError(reply, requestId, error)) return;
  if (isError2(error)) {
    switch (error.code) {
      case ErrorCodes.SESSION_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, error.message, requestId));
        return;
      case ErrorCodes.WORKSPACE_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, error.message, requestId));
        return;
      case ErrorCodes.CONFIG_INVALID:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, error.message, requestId));
        return;
    }
  }
  throw error;
}

export function sendEnvironmentError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  error: unknown,
): boolean {
  if (error instanceof EnvironmentError) {
    reply.send(errEnvelope(environmentErrorCode(error.code), error.message, requestId));
    return true;
  }
  if (error instanceof HandshakeError) {
    reply.send(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error.message, requestId));
    return true;
  }
  return false;
}

function environmentErrorCode(code: EnvironmentError['code']): ErrorCode {
  switch (code) {
    case 'environment.not_found':
      return ErrorCode.ENVIRONMENT_NOT_FOUND;
    case 'environment.invalid_cwd':
      return ErrorCode.VALIDATION_FAILED;
    case 'environment.conflict':
      return ErrorCode.SESSION_BUSY;
    case 'environment.unavailable':
    case 'environment.capability_unavailable':
      return ErrorCode.ENVIRONMENT_UNAVAILABLE;
  }
}
