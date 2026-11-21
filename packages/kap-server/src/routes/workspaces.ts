import {
  ErrorCodes,
  IBootstrapService,
  IHostFileSystem,
  IProjectService,
  IProjectSessions,
  IProjectTrust,
  IProjectTrustStore,
  isError2,
  type Scope,
  type Project,
} from '@moonshot-ai/agent-core-v2';
import { workspaceRootKey } from '@moonshot-ai/agent-core-v2/_base/utils/workdir-slug';
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
  listWorkspacesQuerySchema,
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
import type { Workspace as WorkspaceWire } from '../protocol/workspace';
import { collectFromHosts, hostProjects, type HostSources } from '../services/hosts/hostFanout';

interface WorkspaceRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown },
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

export function registerWorkspacesRoutes(app: WorkspaceRouteHost, core: Scope, hosts?: HostSources): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces',
      querystring: listWorkspacesQuerySchema,
      success: { data: listWorkspacesResponseSchema },
      description:
        'List registered workspaces. hosts=include adds the projects created on each SSH host, tagged with host_id',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const items = await core.accessor.get(IProjectService).list();
      const projected = await Promise.all(items.map((ws) => toWireWorkspace(core, ws)));
      if (req.query.hosts !== 'include' || hosts === undefined) {
        reply.send(okEnvelope({ items: projected }, req.id));
        return;
      }
      const remote = await collectFromHosts(hosts, (session) => hostProjects<WorkspaceWire>(session));
      reply.send(
        okEnvelope({ items: [...projected, ...remote.items] }, req.id),
      );
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
      },
      description: 'Register a workspace (fresh id per call; retry-safe via idempotency_key)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const root = req.body.root;
      if (!isAbsolute(root)) {
        reply.send(
          buildValidationEnvelope(
            [{ path: 'root', message: 'root must be an absolute path' }],
            req.id,
          ),
        );
        return;
      }
      const hostFs = core.accessor.get(IHostFileSystem);
      try {
        const stat = await hostFs.stat(root);
        if (!stat.isDirectory) {
          reply.send(
            errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `root ${root} is not a directory`, req.id),
          );
          return;
        }
      } catch {
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `root ${root} does not exist`, req.id));
        return;
      }
      const additional = await normalizeAdditionalDirsInput(
        core,
        root,
        req.body.additional_dirs ?? [],
        req.id,
      );
      if ('envelope' in additional) {
        reply.send(additional.envelope);
        return;
      }
      const ws = await core.accessor.get(IProjectService).create({
        root,
        name: req.body.name,
        additionalDirs: additional.dirs,
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
      },
      description: 'Update a workspace name and/or source folders (full replace)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const existing = await workspaceOrNotFound(core, req, reply);
      if (existing === undefined) return;
      let additionalDirs: readonly string[] | undefined;
      if (req.body.additional_dirs !== undefined) {
        const additional = await normalizeAdditionalDirsInput(
          core,
          existing.root,
          req.body.additional_dirs,
          req.id,
        );
        if ('envelope' in additional) {
          reply.send(additional.envelope);
          return;
        }
        additionalDirs = additional.dirs;
      }
      const ws = await core.accessor.get(IProjectService).update(existing.id, {
        name: req.body.name,
        additionalDirs,
      });
      if (ws === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${existing.id} does not exist`, req.id),
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
      const existing = await workspaceOrNotFound(core, req, reply);
      if (existing === undefined) return;
      await core.accessor.get(IProjectService).delete(existing.id);
      requestLog(req)?.info({ workspace_id: existing.id }, 'workspace deleted');
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
      const trust = await resolveTrust(core, req, reply);
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
      const trust = await resolveTrust(core, req, reply);
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
      const trust = await resolveTrust(core, req, reply);
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
        [ErrorCode.WORKSPACE_PRIMARY_IMMUTABLE]: {},
      },
      description:
        'Promote a source folder to the primary directory (atomic swap; id and bucket unchanged). An implicit workspace keeps the directory it was opened from and is rejected with WORKSPACE_PRIMARY_IMMUTABLE',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const existing = await workspaceOrNotFound(core, req, reply);
      if (existing === undefined) return;
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
      let ws: Project | undefined;
      try {
        ws = await core.accessor.get(IProjectService).setPrimary(existing.id, resolved);
      } catch (error) {
        if (!isError2(error) || error.code !== ErrorCodes.WORKSPACE_PRIMARY_IMMUTABLE) throw error;
        reply.send(errEnvelope(ErrorCode.WORKSPACE_PRIMARY_IMMUTABLE, error.message, req.id));
        return;
      }
      if (ws === undefined) {
        reply.send(
          errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${existing.id} does not exist`, req.id),
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
      const dirs = await core.accessor.get(IProjectService).readProjectConfigDirs(req.query.root);
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

async function normalizeAdditionalDirsInput(
  core: Scope,
  root: string,
  input: readonly string[],
  requestId: string,
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
      return { envelope: buildDuplicateDirEnvelope(index, dir, requestId) };
    }
    if (dirs.some((kept) => workspaceRootKey(kept) === workspaceRootKey(dir))) {
      return { envelope: buildDuplicateDirEnvelope(index, dir, requestId) };
    }
    dirs.push(dir);
  }
  return { dirs };
}

interface WorkspaceRequest {
  readonly id: string;
  readonly params: { readonly workspace_id: string };
}

type WorkspaceReply = { send(payload: unknown): unknown };

async function workspaceOrNotFound(
  core: Scope,
  req: WorkspaceRequest,
  reply: WorkspaceReply,
): Promise<Project | undefined> {
  const workspaceId = req.params.workspace_id;
  const ws = await core.accessor.get(IProjectService).get(workspaceId);
  if (ws === undefined) {
    reply.send(
      errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, `workspace ${workspaceId} does not exist`, req.id),
    );
  }
  return ws;
}

async function resolveTrust(
  core: Scope,
  req: WorkspaceRequest,
  reply: WorkspaceReply,
): Promise<IProjectTrust | undefined> {
  const ws = await workspaceOrNotFound(core, req, reply);
  return ws === undefined ? undefined : core.accessor.get(IProjectTrustStore).forProject(ws);
}

export async function toWireWorkspace(core: Scope, ws: Project): Promise<WorkspaceWire> {
  const sessionCount = await core.accessor.get(IProjectSessions).count(ws.id);
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
    kind: ws.kind,
    additional_dirs: [...ws.additionalDirs],
    created_at: new Date(ws.createdAt).toISOString(),
    last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
    session_count: sessionCount,
  };
}

function buildDuplicateDirEnvelope(index: number, dir: string, requestId: string) {
  const directory = resolve(dir);
  return errEnvelope(
    ErrorCode.WORKSPACE_DUPLICATE_DIR,
    `Duplicate source folder: ${directory}`,
    requestId,
    [{ path: `additional_dirs.${index}`, directory }],
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
