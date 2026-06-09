/**
 * `/workspaces/*` REST routes.
 *
 * 4 endpoints:
 *
 *   GET    /workspaces                                  → { items }
 *   POST   /workspaces      body: WorkspaceCreate       → Workspace (idempotent)
 *   PATCH  /workspaces/{workspace_id}   body: { name }  → Workspace
 *   DELETE /workspaces/{workspace_id}                   → { deleted: true }
 *
 * **Idempotent POST**: same `root` (post-realpath) always yields the same
 * `wd_<slug>_<hash12>` id; daemon touches `last_opened_at` on existing
 * records and returns the same Workspace. There is no separate
 * `409 already_exists` path — the wire is one of "ok with fresh-mint" or
 * "ok with touch". Callers don't need to distinguish.
 *
 * **Error mapping**:
 *   - `WorkspaceNotFoundError`         → envelope `code: 40410`
 *   - `WorkspaceRootNotFoundError`     → envelope `code: 40409`
 *   - other errors                     → global hook (→ 50001)
 *
 * **Anti-corruption**: zero SDK imports; workspaces are a pure daemon-OWN
 * concept (no agent-core surface).
 */

import {
  ErrorCode,
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  deleteWorkspaceResponseSchema,
  listWorkspacesResponseSchema,
  updateWorkspaceRequestSchema,
  updateWorkspaceResponseSchema,
  workspaceIdParamSchema,
} from '@moonshot-ai/protocol';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  IWorkspaceRegistry,
  WorkspaceNotFoundError,
  WorkspaceRootNotFoundError,
} from '#/services/workspace';

interface WorkspaceRouteHost {
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string },
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

export function registerWorkspacesRoutes(
  app: WorkspaceRouteHost,
  ix: IInstantiationService,
): void {
  // GET /workspaces --------------------------------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces',
      success: { data: listWorkspacesResponseSchema },
      description: 'List registered workspaces',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      try {
        const items = await ix.invokeFunction((a) => a.get(IWorkspaceRegistry).list());
        reply.send(okEnvelope({ items }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<WorkspaceRouteHost['get']>[2],
  );

  // POST /workspaces -------------------------------------------------------
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces',
      body: createWorkspaceRequestSchema,
      success: { data: createWorkspaceResponseSchema },
      description: 'Register a workspace (idempotent on root)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      try {
        const ws = await ix.invokeFunction((a) =>
          a.get(IWorkspaceRegistry).createOrTouch(req.body.root, req.body.name),
        );
        reply.send(okEnvelope(ws, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<WorkspaceRouteHost['post']>[2],
  );

  // PATCH /workspaces/{workspace_id} ---------------------------------------
  const updateRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/workspaces/{workspace_id}',
      params: workspaceIdParamSchema,
      body: updateWorkspaceRequestSchema,
      success: { data: updateWorkspaceResponseSchema },
      description: 'Rename a workspace (display name only)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      try {
        const { workspace_id } = req.params;
        const ws = await ix.invokeFunction((a) =>
          a.get(IWorkspaceRegistry).update(workspace_id, { name: req.body.name }),
        );
        reply.send(okEnvelope(ws, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.patch(
    updateRoute.path,
    updateRoute.options,
    updateRoute.handler as Parameters<WorkspaceRouteHost['patch']>[2],
  );

  // DELETE /workspaces/{workspace_id} --------------------------------------
  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/workspaces/{workspace_id}',
      params: workspaceIdParamSchema,
      success: { data: deleteWorkspaceResponseSchema },
      description: 'Unregister a workspace (does not remove on-disk content)',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      try {
        const { workspace_id } = req.params;
        await ix.invokeFunction((a) => a.get(IWorkspaceRegistry).delete(workspace_id));
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<WorkspaceRouteHost['delete']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof WorkspaceNotFoundError) {
    reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof WorkspaceRootNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
}
