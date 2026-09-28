import {
  Error2,
  ErrorCodes,
  IAgentEnvironmentBindingService,
  IBootstrapService,
  IEnvironmentDeclarationService,
  IHostFileSystem,
  ISessionContext,
  IWorkspaceInstanceManager,
  IEnvironmentService,
  IWorkspaceService,
  environmentEntryInfo,
  readSshConfigHosts,
  resumeSessionById,
  EnvironmentError,
  isError2,
  type IAgentScopeHandle,
  type RemoteEnvironmentEntry,
  type EnvironmentBinding,
  type EnvironmentGenerationSnapshot,
  type Scope,
  type WorkspaceInstance,
} from '@moonshot-ai/agent-core-v2';
import { HandshakeError } from '@moonshot-ai/agent-core-v2/remote';

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
}

export function registerEnvironmentRoutes(app: EnvironmentRouteHost, core: Scope): void {
  const getRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/environment',
      params: sessionEnvironmentParamsSchema,
      success: { data: environmentBindingResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
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

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/environments',
      params: sessionEnvironmentParamsSchema,
      success: { data: sessionEnvironmentsResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
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
        const workspaceId = session.accessor.get(ISessionContext).workspaceId;
        const declarations = await resolveDeclarations(core);
        const payload: SessionEnvironmentsResponse = {
          workspace_id: workspaceId,
          environments: core.accessor.get(IEnvironmentService).snapshot().environments.map((environment) =>
            toEntry(environment, declarations.get(environment.environmentId)),
          ),
          ssh_hosts: [...await resolveSshHosts(core)],
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

export async function resolveWorkspaceInstance(core: Scope, workspaceId: string): Promise<WorkspaceInstance> {
  const manager = core.accessor.get(IWorkspaceInstanceManager);
  const existing = manager.get(workspaceId);
  if (existing !== undefined) return existing;
  const ws = await core.accessor.get(IWorkspaceService).get(workspaceId);
  if (ws === undefined) {
    throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${workspaceId} does not exist`);
  }
  return manager.getOrCreate({ workspaceId, root: ws.root });
}

async function resolveDeclarations(
  core: Scope,
): Promise<ReadonlyMap<string, RemoteEnvironmentEntry>> {
  const declarations = await core.accessor.get(IEnvironmentDeclarationService).declarations();
  return new Map((declarations?.entries ?? []).map((declaration) => [declaration.id, declaration.entry]));
}

async function resolveSshHosts(core: Scope): Promise<readonly string[]> {
  try {
    return await readSshConfigHosts(
      core.accessor.get(IHostFileSystem),
      core.accessor.get(IBootstrapService).osHomeDir,
    );
  } catch {
    return [];
  }
}

function toEntry(environment: EnvironmentGenerationSnapshot, entry: RemoteEnvironmentEntry | undefined): SessionEnvironmentEntry {
  const info = environmentEntryInfo(environment, entry);
  return {
    environment_id: info.environmentId,
    type: info.type,
    status: info.status,
    generation: info.generation,
    capabilities: [...info.capabilities],
    default_cwd: info.defaultCwd,
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

export function environmentErrorCode(code: EnvironmentError['code']): ErrorCode {
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
