import {
  Error2,
  ErrorCodes,
  IAgentRuntimeBindingService,
  IAgentRuntimeService,
  IAtomicDocumentStore,
  IBootstrapService,
  IConfigService,
  IFlagService,
  IHostFileSystem,
  ISessionContext,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  REMOTE_RUNTIME_FLAG_ID,
  readSshConfigHosts,
  resolveWorkspaceRuntimeDeclarations,
  resumeSessionById,
  RuntimeError,
  type IAgentScopeHandle,
  type RemoteRuntimeEntry,
  type RuntimeBinding,
  type RuntimeGenerationSnapshot,
  type Scope,
  type WorkspaceInstance,
} from '@moonshot-ai/agent-core-v2';
import { HandshakeError } from '@moonshot-ai/remote-exec';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  runtimeBindingResponseSchema,
  sessionRuntimeParamsSchema,
  sessionRuntimesResponseSchema,
  switchRuntimeRequestSchema,
  type RuntimeBindingResponse,
  type SessionRuntimeEntry,
  type SessionRuntimesResponse,
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
      const agent = await resolveRuntimeAgent(core, req.params.session_id);
      reply.send(okEnvelope(toResponse(agent.accessor.get(IAgentRuntimeBindingService).get()), req.id));
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
        [ErrorCode.SESSION_BUSY]: {},
      },
      description: 'Switch the main agent runtime binding',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        const agent = await resolveRuntimeAgent(core, req.params.session_id);
        const service = agent.accessor.get(IAgentRuntimeBindingService);
        const binding = remoteRuntimeEnabled(core)
          ? await service.connectAndSwitch(req.body.runtime_id, req.body.cwd)
          : service.switch(req.body.runtime_id);
        reply.send(okEnvelope(toResponse(binding), req.id));
      } catch (error) {
        sendRuntimeRouteError(reply, req.id, error);
      }
    },
  );
  app.post(switchRoute.path, switchRoute.options, switchRoute.handler as Parameters<RuntimeRouteHost['post']>[2]);

  const reconnectRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/runtime/reconnect',
      params: sessionRuntimeParamsSchema,
      success: { data: runtimeBindingResponseSchema },
      errors: {
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.RUNTIME_NOT_FOUND]: {},
        [ErrorCode.RUNTIME_UNAVAILABLE]: {},
      },
      description: 'Reconnect the main agent runtime (experimental remote runtime)',
      tags: ['sessions'],
    },
    async (req, reply) => {
      try {
        if (!remoteRuntimeEnabled(core)) {
          reply.send(
            errEnvelope(
              ErrorCode.RUNTIME_UNAVAILABLE,
              'runtime reconnect is unavailable: experimental flag remote_runtime is disabled',
              req.id,
            ),
          );
          return;
        }
        const agent = await resolveRuntimeAgent(core, req.params.session_id);
        await agent.accessor.get(IAgentRuntimeService).reconnect();
        reply.send(okEnvelope(toResponse(agent.accessor.get(IAgentRuntimeBindingService).get()), req.id));
      } catch (error) {
        sendRuntimeRouteError(reply, req.id, error);
      }
    },
  );
  app.post(reconnectRoute.path, reconnectRoute.options, reconnectRoute.handler as Parameters<RuntimeRouteHost['post']>[2]);

  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/runtimes',
      params: sessionRuntimeParamsSchema,
      success: { data: sessionRuntimesResponseSchema },
      errors: { [ErrorCode.SESSION_NOT_FOUND]: {} },
      description: 'List the runtimes registered for the session workspace',
      tags: ['sessions'],
    },
    async (req, reply) => {
      const session = await resumeSessionById(core.accessor, req.params.session_id);
      if (session === undefined) {
        throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${req.params.session_id} does not exist`);
      }
      const workspaceId = session.accessor.get(ISessionContext).workspaceId;
      const instance = await resolveWorkspaceInstance(core, workspaceId);
      const enabled = remoteRuntimeEnabled(core);
      const declarations = enabled ? await resolveDeclarations(core, instance.root) : new Map<string, RemoteRuntimeEntry>();
      const payload: SessionRuntimesResponse = {
        workspace_id: workspaceId,
        runtimes: instance.runtimes.snapshot().runtimes.map((runtime) =>
          toEntry(runtime, declarations.get(runtime.runtimeId)),
        ),
        ssh_hosts: enabled ? [...await resolveSshHosts(core)] : [],
      };
      reply.send(okEnvelope(payload, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<RuntimeRouteHost['get']>[2]);
}

function remoteRuntimeEnabled(core: Scope): boolean {
  return core.accessor.get(IFlagService).enabled(REMOTE_RUNTIME_FLAG_ID);
}

async function resolveRuntimeAgent(core: Scope, sessionId: string): Promise<IAgentScopeHandle> {
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
): Promise<ReadonlyMap<string, RemoteRuntimeEntry>> {
  try {
    const resolved = await resolveWorkspaceRuntimeDeclarations({
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

function toEntry(runtime: RuntimeGenerationSnapshot, entry: RemoteRuntimeEntry | undefined): SessionRuntimeEntry {
  return {
    runtime_id: runtime.runtimeId,
    type: runtimeType(runtime.runtimeId, entry),
    status: runtime.status,
    generation: runtime.generation,
    capabilities: [...runtime.capabilities],
    default_cwd: entry?.defaultCwd,
  };
}

function runtimeType(runtimeId: string, entry: RemoteRuntimeEntry | undefined): SessionRuntimeEntry['type'] {
  if (runtimeId === 'local') return 'local';
  if (entry === undefined || 'command' in entry) return 'command';
  return entry.type;
}

function toResponse(binding: RuntimeBinding): RuntimeBindingResponse {
  return { workspace_id: binding.workspaceId, runtime_id: binding.runtimeId, cwd: binding.cwd };
}

function sendRuntimeRouteError(
  reply: { send(payload: unknown): void },
  requestId: string,
  error: unknown,
): void {
  if (error instanceof RuntimeError) {
    reply.send(errEnvelope(runtimeErrorCode(error.code), error.message, requestId));
    return;
  }
  if (error instanceof HandshakeError) {
    reply.send(errEnvelope(ErrorCode.RUNTIME_UNAVAILABLE, error.message, requestId));
    return;
  }
  throw error;
}

function runtimeErrorCode(code: RuntimeError['code']): ErrorCode {
  switch (code) {
    case 'runtime.not_found':
      return ErrorCode.RUNTIME_NOT_FOUND;
    case 'runtime.invalid_cwd':
      return ErrorCode.VALIDATION_FAILED;
    case 'runtime.conflict':
      return ErrorCode.SESSION_BUSY;
    case 'runtime.unavailable':
    case 'runtime.capability_unavailable':
      return ErrorCode.RUNTIME_UNAVAILABLE;
  }
}
