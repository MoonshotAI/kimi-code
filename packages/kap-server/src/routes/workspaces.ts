/**
 * `/workspaces` route handlers — server-v2 port.
 *
 * Implements the v1 `/api/v1/workspaces` wire contract on top of
 * `agent-core-v2` services. Backed by `IWorkspaceService` (App scope) for the
 * catalog, `IHostFileSystem` to validate roots, and
 * `IWorkspaceSessions` to derive `session_count`.
 *
 *   GET    /workspaces                    list
 *   POST   /workspaces                    register (idempotent on root)
 *   PATCH  /workspaces/{workspace_id}     rename (display name only)
 *   DELETE /workspaces/{workspace_id}     unregister
 *
 * **Wire fidelity**: the v1 `workspaceSchema` carries more fields than v2's
 * `Workspace` (`{ id, root, name, createdAt, lastOpenedAt }`). The handler
 * projects the v2 record onto the v1 shape, deriving the extra fields:
 *   - `created_at` / `last_opened_at` — from the registry's in-memory
 *     timestamps (reset on restart; the registry is still a skeleton).
 *   - `session_count` — count of persisted sessions for the workspace, summed
 *     across every id spelling of the same root (`IWorkspaceSessions.count`
 *     folds the alias set) so legacy split buckets count once for the
 *     workspace, not per bucket.
 */

import {
  IHostFileSystem,
  IWorkspaceService,
  IWorkspaceSessions,
  type Scope,
  type Workspace,
} from '@moonshot-ai/agent-core-v2';
import { isAbsolute } from 'node:path';

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
  updateWorkspaceRequestSchema,
  updateWorkspaceResponseSchema,
  workspaceIdParamSchema,
} from '../protocol/rest-workspace';
import type { Workspace as WorkspaceWire } from '../protocol/workspace';

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
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
      },
      description: 'Register a workspace (idempotent on root)',
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
      const ws = await core.accessor.get(IWorkspaceService).createOrTouch(root, req.body.name);
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
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
      },
      description: 'Rename a workspace (display name only)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const ws = await core.accessor
        .get(IWorkspaceService)
        .update(workspace_id, { name: req.body.name });
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
}

// ---------------------------------------------------------------------------
// Projection — v2 `Workspace` onto the v1 wire `workspaceSchema`.
// ---------------------------------------------------------------------------

async function toWireWorkspace(core: Scope, ws: Workspace): Promise<WorkspaceWire> {
  const sessionCount = await core.accessor.get(IWorkspaceSessions).count(ws.id);
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
    created_at: new Date(ws.createdAt).toISOString(),
    last_opened_at: new Date(ws.lastOpenedAt).toISOString(),
    session_count: sessionCount,
  };
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
