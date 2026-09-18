import {
  Error2,
  ErrorCodes,
  IAgentEnvironmentBindingService,
  IAgentEnvironmentService,
  IAtomicDocumentStore,
  IBootstrapService,
  IConfigService,
  IHostFileSystem,
  ISessionContext,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  ENVIRONMENTS_SECTION,
  readSshConfigHosts,
  resolveWorkspaceEnvironmentDeclarations,
  resumeSessionById,
  writeProjectEnvironmentDeclaration,
  EnvironmentError,
  type IAgentScopeHandle,
  type RemoteEnvironmentEntry,
  type EnvironmentBinding,
  type EnvironmentGenerationSnapshot,
  type Scope,
  type WorkspaceInstance,
} from '@moonshot-ai/agent-core-v2';
import { HandshakeError } from '@moonshot-ai/remote-exec';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  environmentBindingResponseSchema,
  sessionEnvironmentParamsSchema,
  sessionEnvironmentsResponseSchema,
  switchEnvironmentRequestSchema,
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
      req: { id: string; params: unknown; body: unknown },
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
      const agent = await resolveEnvironmentAgent(core, req.params.session_id);
      reply.send(okEnvelope(toResponse(agent.accessor.get(IAgentEnvironmentBindingService).get()), req.id));
    },
  );
  app.get(getRoute.path, getRoute.options, getRoute.handler as Parameters<EnvironmentRouteHost['get']>[2]);

  const switchRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/environment',
      params: sessionEnvironmentParamsSchema,
      body: switchEnvironmentRequestSchema,
      success: { data: environmentBindingResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: 'Switch the main agent environment binding',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const agent = await resolveEnvironmentAgent(core, req.params.session_id);
        const service = agent.accessor.get(IAgentEnvironmentBindingService);
        const binding = await service.connectAndSwitch(req.body.environment_id, req.body.cwd);
        reply.send(okEnvelope(toResponse(binding), req.id));
      } catch (error) {
        sendEnvironmentRouteError(reply, req.id, error);
      }
    },
  );
  app.post(switchRoute.path, switchRoute.options, switchRoute.handler as Parameters<EnvironmentRouteHost['post']>[2]);

  const reconnectRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/environment/reconnect',
      params: sessionEnvironmentParamsSchema,
      success: { data: environmentBindingResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description: 'Reconnect the main agent environment',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const agent = await resolveEnvironmentAgent(core, req.params.session_id);
        await agent.accessor.get(IAgentEnvironmentService).reconnect();
        reply.send(okEnvelope(toResponse(agent.accessor.get(IAgentEnvironmentBindingService).get()), req.id));
      } catch (error) {
        sendEnvironmentRouteError(reply, req.id, error);
      }
    },
  );
  app.post(reconnectRoute.path, reconnectRoute.options, reconnectRoute.handler as Parameters<EnvironmentRouteHost['post']>[2]);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/environments',
      params: sessionEnvironmentParamsSchema,
      success: { data: sessionEnvironmentsResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the environments registered for the session workspace',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const session = await resumeSessionById(core.accessor, req.params.session_id);
      if (session === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${req.params.session_id} does not exist`);
      }
      const workspaceId = session.accessor.get(ISessionContext).workspaceId;
      const instance = await resolveWorkspaceInstance(core, workspaceId);
      const declarations = await resolveDeclarations(core, instance.root);
      const payload: SessionEnvironmentsResponse = {
        workspace_id: workspaceId,
        environments: instance.environments.snapshot().environments.map((environment) =>
          toEntry(environment, declarations.get(environment.environmentId)),
        ),
        ssh_hosts: [...await resolveSshHosts(core)],
      };
      reply.send(okEnvelope(payload, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<EnvironmentRouteHost['get']>[2]);

  const declareRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/environments',
      params: sessionEnvironmentParamsSchema,
      body: declareEnvironmentRequestSchema,
      success: { data: declareEnvironmentResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description: 'Declare an environment for the session workspace',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const session = await resumeSessionById(core.accessor, req.params.session_id);
        if (session === undefined) {
          throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${req.params.session_id} does not exist`);
        }
        const workspaceId = session.accessor.get(ISessionContext).workspaceId;
        const scope = req.body.scope ?? 'global';
        const entry = toEngineEnvironmentEntry(req.body.entry);
        if (scope === 'project') {
          const instance = await resolveWorkspaceInstance(core, workspaceId);
          await writeProjectEnvironmentDeclaration(
            core.accessor.get(IHostFileSystem),
            instance.root,
            req.body.environment_id,
            entry,
          );
        } else {
          const config = core.accessor.get(IConfigService);
          await config.ready;
          const declared = config.get<Record<string, unknown>>(ENVIRONMENTS_SECTION);
          if (declared?.[req.body.environment_id] !== undefined) {
            throw new Error2(
              ErrorCodes.CONFIG_INVALID,
              `Environment id "${req.body.environment_id}" is already declared in ${core.accessor.get(IBootstrapService).configPath}.`,
            );
          }
          await config.set(ENVIRONMENTS_SECTION, { [req.body.environment_id]: entry });
        }
        reply.send(okEnvelope({ workspace_id: workspaceId, environment_id: req.body.environment_id, scope }, req.id));
      } catch (error) {
        sendEnvironmentRouteError(reply, req.id, error);
      }
    },
  );
  app.post(declareRoute.path, declareRoute.options, declareRoute.handler as Parameters<EnvironmentRouteHost['post']>[2]);
}

const declareEnvironmentEntrySchema = z.union([
  z
    .object({
      type: z.literal('ssh'),
      host: z.string().min(1),
      remote_bin: z.string().min(1).optional(),
      default_cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('docker'),
      container: z.string().min(1),
      context: z.string().min(1).optional(),
      remote_bin: z.string().min(1).optional(),
      default_cwd: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      default_cwd: z.string().min(1).optional(),
    })
    .strict(),
]);

const declareEnvironmentRequestSchema = z.object({
  environment_id: z.string().min(1),
  scope: z.enum(['global', 'project']).optional(),
  entry: declareEnvironmentEntrySchema,
});

const declareEnvironmentResponseSchema = z.object({
  workspace_id: z.string(),
  environment_id: z.string(),
  scope: z.enum(['global', 'project']),
});

function toEngineEnvironmentEntry(entry: z.infer<typeof declareEnvironmentEntrySchema>): RemoteEnvironmentEntry {
  if ('command' in entry) {
    return { command: entry.command, args: entry.args, env: entry.env, defaultCwd: entry.default_cwd };
  }
  if (entry.type === 'ssh') {
    return { type: 'ssh', host: entry.host, remoteBin: entry.remote_bin, defaultCwd: entry.default_cwd };
  }
  return {
    type: 'docker',
    container: entry.container,
    context: entry.context,
    remoteBin: entry.remote_bin,
    defaultCwd: entry.default_cwd,
  };
}

async function resolveEnvironmentAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return ensureMainAgent(session);
}

async function resolveWorkspaceInstance(core: Scope, workspaceId: string): Promise<WorkspaceInstance> {
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
  root: string,
): Promise<ReadonlyMap<string, RemoteEnvironmentEntry>> {
  try {
    const resolved = await resolveWorkspaceEnvironmentDeclarations({
      config: core.accessor.get(IConfigService),
      fs: core.accessor.get(IHostFileSystem),
      docs: core.accessor.get(IAtomicDocumentStore),
      root,
    });
    return new Map(resolved.entries.map((declaration) => [declaration.id, declaration.entry]));
  } catch {
    return new Map();
  }
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
  return {
    environment_id: environment.environmentId,
    type: environmentType(environment.environmentId, entry),
    status: environment.status,
    generation: environment.generation,
    capabilities: [...environment.capabilities],
    default_cwd: entry?.defaultCwd,
    connect_error: environment.connectError,
  };
}

function environmentType(environmentId: string, entry: RemoteEnvironmentEntry | undefined): SessionEnvironmentEntry['type'] {
  if (environmentId === 'local') return 'local';
  if (entry === undefined || 'command' in entry) return 'command';
  return entry.type;
}

function toResponse(binding: EnvironmentBinding): EnvironmentBindingResponse {
  return { workspace_id: binding.workspaceId, environment_id: binding.environmentId, cwd: binding.cwd };
}

function sendEnvironmentRouteError(
  reply: { send(payload: unknown): void },
  requestId: string,
  error: unknown,
): void {
  if (error instanceof EnvironmentError) {
    reply.send(errEnvelope(environmentErrorCode(error.code), error.message, requestId));
    return;
  }
  if (error instanceof HandshakeError) {
    reply.send(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error.message, requestId));
    return;
  }
  throw error;
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
