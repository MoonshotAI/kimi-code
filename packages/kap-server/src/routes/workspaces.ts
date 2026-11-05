import {
  IBootstrapService,
  IEnvironmentService,
  IHostFileSystem,
  IWorkspaceService,
  LOCAL_ENVIRONMENT_ID,
  workspaceDirectories,
  workspaceEnvironmentId,
  IWorkspaceSessions,
  IWorkspaceTrust,
  IWorkspaceTrustStore,
  type Scope,
  type Workspace,
} from '@moonshot-ai/agent-core-v2';
import { workspaceRootKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
import { normalizeRemoteCwd, requireEnvironmentDirectory } from '@moonshot-ai/agent-core-v2/environment/environmentDefaults';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  deleteWorkspaceResponseSchema,
  listWorkspacesResponseSchema,
  projectConfigDirsQuerySchema,
  projectConfigDirsResponseSchema,
  setPrimaryRequestSchema,
  setPrimaryResponseSchema,
  updateWorkspaceRequestSchema,
  updateWorkspaceResponseSchema,
  workspaceIdParamSchema,
  workspaceTrustResponseSchema,
} from '../protocol/rest-workspace';
import type { WorkspaceDirectory as WorkspaceDirectoryWire, Workspace as WorkspaceWire } from '../protocol/workspace';
import { sendEnvironmentError } from './environment';

interface WorkspaceRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string },
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
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));
const duplicateDirDetailsSchema = z.array(z.object({ path: z.string(), directory: z.string() }));

export function registerWorkspacesRoutes(app: WorkspaceRouteHost, core: Scope): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces',
      success: { data: listWorkspacesResponseSchema },
      description: 'List registered workspaces',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const items = await core.accessor.get(IWorkspaceService).list();
      const projected = await Promise.all(items.map((ws) => toWireWorkspace(core, ws)));
      reply.send(okEnvelope({ items: projected }, req.id));
    },
  );
  app.get(listRoute.path, listRoute.options, listRoute.handler as Parameters<WorkspaceRouteHost['get']>[2]);

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces',
      body: createWorkspaceRequestSchema,
      success: { data: createWorkspaceResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_DUPLICATE_DIR]: { detailsSchema: duplicateDirDetailsSchema },
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description: 'Register a workspace (fresh id per call; retry-safe via idempotency_key)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const directories = req.body.directories ?? [
        { environment_id: LOCAL_ENVIRONMENT_ID, path: req.body.root! },
        ...(req.body.additional_dirs ?? []).map((path) => ({ environment_id: LOCAL_ENVIRONMENT_ID, path })),
      ];
      const resolved = await normalizeDirectoriesInput(core, directories, req.body.directories === undefined, req.id);
      if ('envelope' in resolved) {
        reply.send(resolved.envelope);
        return;
      }
      if ('error' in resolved) {
        if (!sendEnvironmentError(reply, req.id, resolved.error)) throw resolved.error;
        return;
      }
      const ws = await core.accessor.get(IWorkspaceService).create({
        ...resolved.parts,
        name: req.body.name,
        idempotencyKey: req.body.idempotency_key,
      });
      reply.send(okEnvelope(await toWireWorkspace(core, ws), req.id));
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<WorkspaceRouteHost['post']>[2],
  );

  const updateRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/workspaces/{workspace_id}',
      params: workspaceIdParamSchema,
      body: updateWorkspaceRequestSchema,
      success: { data: updateWorkspaceResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_DUPLICATE_DIR]: { detailsSchema: duplicateDirDetailsSchema },
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description: 'Update a workspace name and/or source folders (full replace)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const registry = core.accessor.get(IWorkspaceService);
      const existing = await registry.get(workspace_id);
      if (existing === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspace_id} does not exist`, req.id),
        );
        return;
      }
      const environmentId = workspaceEnvironmentId(existing);
      const directories = req.body.directories ?? (req.body.additional_dirs === undefined
        ? undefined
        : [
            { environment_id: environmentId, path: existing.root },
            ...req.body.additional_dirs.map((path) => ({ environment_id: environmentId, path })),
          ]);
      let parts: DirectoryParts | undefined;
      if (directories !== undefined) {
        if (directories[0]!.environment_id !== environmentId) {
          reply.send(buildValidationEnvelope([{ path: 'directories.0.environment_id', message: 'the workspace environment cannot change' }], req.id));
          return;
        }
        const resolved = await normalizeDirectoriesInput(core, directories, req.body.directories === undefined, req.id);
        if ('envelope' in resolved) {
          reply.send(resolved.envelope);
          return;
        }
        if ('error' in resolved) {
          if (!sendEnvironmentError(reply, req.id, resolved.error)) throw resolved.error;
          return;
        }
        parts = resolved.parts;
      }
      const ws = await registry.update(workspace_id, {
        name: req.body.name,
        ...(parts === undefined
          ? {}
          : {
              directories: workspaceDirectories(parts),
            }),
      });
      if (ws === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspace_id} does not exist`, req.id),
        );
        return;
      }
      reply.send(okEnvelope(await toWireWorkspace(core, ws), req.id));
    },
  );
  app.patch(
    updateRoute.path,
    updateRoute.options,
    updateRoute.handler as Parameters<WorkspaceRouteHost['patch']>[2],
  );

  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/workspaces/{workspace_id}',
      params: workspaceIdParamSchema,
      success: { data: deleteWorkspaceResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Unregister a workspace (does not remove on-disk content)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const registry = core.accessor.get(IWorkspaceService);
      const existing = await registry.get(workspace_id);
      if (existing === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspace_id} does not exist`, req.id),
        );
        return;
      }
      await registry.delete(workspace_id);
      requestLog(req)?.info({ workspace_id }, 'workspace deleted');
      reply.send(okEnvelope({ deleted: true as const }, req.id));
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<WorkspaceRouteHost['delete']>[2],
  );

  const getTrustRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/trust',
      params: workspaceIdParamSchema,
      success: { data: workspaceTrustResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Read the workspace trust state',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const trust = await resolveTrust(core, req.params.workspace_id, req.id, reply);
      if (trust === undefined) return;
      reply.send(okEnvelope({ trusted: await trust.get() }, req.id));
    },
  );
  app.get(
    getTrustRoute.path,
    getTrustRoute.options,
    getTrustRoute.handler as Parameters<WorkspaceRouteHost['get']>[2],
  );

  const trustRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/trust',
      params: workspaceIdParamSchema,
      success: { data: workspaceTrustResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Mark the workspace trusted (project-level MCP config loads)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const trust = await resolveTrust(core, req.params.workspace_id, req.id, reply);
      if (trust === undefined) return;
      await trust.trust();
      reply.send(okEnvelope({ trusted: true }, req.id));
    },
  );
  app.post(
    trustRoute.path,
    trustRoute.options,
    trustRoute.handler as Parameters<WorkspaceRouteHost['post']>[2],
  );

  const untrustRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/untrust',
      params: workspaceIdParamSchema,
      success: { data: workspaceTrustResponseSchema },
      errors: {
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Revoke persisted workspace trust (project-level MCP config unloads unless process or config overrides apply)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const trust = await resolveTrust(core, req.params.workspace_id, req.id, reply);
      if (trust === undefined) return;
      await trust.untrust();
      reply.send(okEnvelope({ trusted: await trust.get() }, req.id));
    },
  );
  app.post(
    untrustRoute.path,
    untrustRoute.options,
    untrustRoute.handler as Parameters<WorkspaceRouteHost['post']>[2],
  );

  const setPrimaryRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/primary',
      params: workspaceIdParamSchema,
      body: setPrimaryRequestSchema,
      success: { data: setPrimaryResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Promote a source folder to the primary directory (atomic swap; id and bucket unchanged)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const registry = core.accessor.get(IWorkspaceService);
      const existing = await registry.get(workspace_id);
      if (existing === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspace_id} does not exist`, req.id),
        );
        return;
      }
      if (workspaceEnvironmentId(existing) !== LOCAL_ENVIRONMENT_ID) {
        if (req.body.path !== existing.root) {
          reply.send(buildValidationEnvelope([{ path: 'path', message: 'path is not in the workspace dir set' }], req.id));
          return;
        }
        reply.send(okEnvelope(await toWireWorkspace(core, existing), req.id));
        return;
      }
      const resolved = resolveAdditionalDirPath(core, existing.root, req.body.path);
      const resolvedKey = workspaceRootKey(resolved);
      const inSet =
        resolvedKey === workspaceRootKey(existing.root) ||
        existing.additionalDirs.some((dir) => workspaceRootKey(dir) === resolvedKey);
      if (!inSet) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'path', message: 'path is not in the workspace dir set' }],
            req.id,
          ),
        );
        return;
      }
      const hostFs = core.accessor.get(IHostFileSystem);
      try {
        const stat = await hostFs.stat(resolved);
        if (!stat.isDirectory) {
          reply.send(
            errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path ${req.body.path} is not a directory`, req.id),
          );
          return;
        }
      } catch {
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path ${req.body.path} does not exist`, req.id),
        );
        return;
      }
      const ws = await registry.setPrimary(workspace_id, resolved);
      if (ws === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspace_id} does not exist`, req.id),
        );
        return;
      }
      reply.send(okEnvelope(await toWireWorkspace(core, ws), req.id));
    },
  );
  app.post(
    setPrimaryRoute.path,
    setPrimaryRoute.options,
    setPrimaryRoute.handler as Parameters<WorkspaceRouteHost['post']>[2],
  );

  const projectConfigDirsRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/project-config-dirs',
      querystring: projectConfigDirsQuerySchema,
      success: { data: projectConfigDirsResponseSchema },
      description: 'Read a project local.toml additional_dir set without mutating anything',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const dirs = await core.accessor.get(IWorkspaceService).readProjectConfigDirs(req.query.root);
      reply.send(okEnvelope({ additional_dirs: dirs }, req.id));
    },
  );
  app.get(
    projectConfigDirsRoute.path,
    projectConfigDirsRoute.options,
    projectConfigDirsRoute.handler as Parameters<WorkspaceRouteHost['get']>[2],
  );
}

function resolveAdditionalDirPath(core: Scope, root: string, input: string): string {
  const trimmed = input.trim();
  const osHomeDir = core.accessor.get(IBootstrapService).osHomeDir;
  const expanded =
    trimmed === '~'
      ? osHomeDir
      : trimmed.startsWith('~/')
        ? join(osHomeDir, trimmed.slice(2))
        : trimmed;
  return isAbsolute(expanded) ? normalize(expanded) : resolve(root, expanded);
}

type DirectoryParts = Pick<Workspace, 'root' | 'primaryEnvironmentId' | 'additionalDirs'>;

async function normalizeDirectoriesInput(
  core: Scope,
  input: readonly WorkspaceDirectoryWire[],
  legacyFields: boolean,
  requestId: string,
): Promise<{ readonly parts: DirectoryParts } | { readonly envelope: unknown } | { readonly error: unknown }> {
  const rootField = legacyFields ? 'root' : 'directories.0.path';
  const environmentId = input[0]!.environment_id;
  const mixed = input.findIndex((dir) => dir.environment_id !== environmentId);
  if (mixed >= 0) {
    return {
      envelope: buildValidationEnvelope(
        [{ path: `directories.${mixed}.environment_id`, message: 'all directories must use the same environment' }],
        requestId,
      ),
    };
  }
  if (environmentId !== LOCAL_ENVIRONMENT_ID) {
    if (input.length > 1) {
      return {
        envelope: buildValidationEnvelope(
          [{ path: legacyFields ? 'additional_dirs.0' : 'directories.1', message: 'remote workspaces support a single directory' }],
          requestId,
        ),
      };
    }
    let root: string;
    try {
      root = normalizeRemoteCwd(input[0]!.path);
    } catch (error) {
      return {
        envelope: buildValidationEnvelope(
          [{ path: rootField, message: error instanceof Error ? error.message : String(error) }],
          requestId,
        ),
      };
    }
    try {
      await requireEnvironmentDirectory(core.accessor.get(IEnvironmentService), environmentId, root);
    } catch (error) {
      return { error };
    }
    return { parts: { root, primaryEnvironmentId: environmentId, additionalDirs: [] } };
  }
  const root = input[0]!.path;
  if (!isAbsolute(root)) {
    return {
      envelope: buildValidationEnvelope([{ path: rootField, message: 'root must be an absolute path' }], requestId),
    };
  }
  const hostFs = core.accessor.get(IHostFileSystem);
  try {
    const stat = await hostFs.stat(root);
    if (!stat.isDirectory) {
      return { envelope: errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `root ${root} is not a directory`, requestId) };
    }
  } catch {
    return { envelope: errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `root ${root} does not exist`, requestId) };
  }
  const additional = await normalizeAdditionalDirsInput(
    core,
    root,
    input.slice(1).map((dir) => dir.path),
    requestId,
    legacyFields ? (index) => `additional_dirs.${index}` : (index) => `directories.${index + 1}`,
  );
  if ('envelope' in additional) return additional;
  return { parts: { root, additionalDirs: additional.dirs } };
}

async function normalizeAdditionalDirsInput(
  core: Scope,
  root: string,
  input: readonly string[],
  requestId: string,
  field: (index: number) => string,
): Promise<{ readonly dirs: string[] } | { readonly envelope: unknown }> {
  const hostFs = core.accessor.get(IHostFileSystem);
  const rootKey = workspaceRootKey(root);
  const dirs: string[] = [];
  for (const [index, raw] of input.entries()) {
    const dir = resolveAdditionalDirPath(core, root, raw);
    try {
      const stat = await hostFs.stat(dir);
      if (!stat.isDirectory) {
        return {
          envelope: errEnvelope(
            ErrorCode.FS_PATH_NOT_FOUND,
            `path ${raw} is not a directory`,
            requestId,
          ),
        };
      }
    } catch {
      return {
        envelope: errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path ${raw} does not exist`, requestId),
      };
    }
    if (workspaceRootKey(dir) === rootKey) {
      return { envelope: buildDuplicateDirEnvelope(field(index), dir, requestId) };
    }
    if (dirs.some((kept) => workspaceRootKey(kept) === workspaceRootKey(dir))) {
      return { envelope: buildDuplicateDirEnvelope(field(index), dir, requestId) };
    }
    dirs.push(dir);
  }
  return { dirs };
}

type TrustReply = { send(payload: unknown): unknown };

async function resolveTrust(
  core: Scope,
  workspaceId: string,
  requestId: string,
  reply: TrustReply,
): Promise<IWorkspaceTrust | undefined> {
  const ws = await core.accessor.get(IWorkspaceService).get(workspaceId);
  if (ws === undefined) {
    reply.send(
      errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspaceId} does not exist`, requestId),
    );
    return undefined;
  }
  return core.accessor.get(IWorkspaceTrustStore).forRoot(ws.root);
}

export async function toWireWorkspace(core: Scope, ws: Workspace): Promise<WorkspaceWire> {
  const sessionCount = await core.accessor.get(IWorkspaceSessions).count(ws.id);
  return {
    id: ws.id,
    root: ws.root,
    primary_environment_id: workspaceEnvironmentId(ws),
    directories: workspaceDirectories(ws).map((dir) => ({ environment_id: dir.environmentId, path: dir.path })),
    name: ws.name,
    kind: ws.kind,
    additional_dirs: [...ws.additionalDirs],
    created_at: new Date(ws.createdAt).toISOString(),
    last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
    session_count: sessionCount,
  };
}

function buildDuplicateDirEnvelope(field: string, dir: string, requestId: string) {
  const directory = resolve(dir);
  return errEnvelope(
    ErrorCode.WORKSPACE_DUPLICATE_DIR,
    `Duplicate source folder: ${directory}`,
    requestId,
    undefined,
    [{ path: field, directory }],
  );
}

function buildValidationEnvelope(
  details: { path: string; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const first = details[0];
  const msg = first === undefined ? 'validation failed' : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}
