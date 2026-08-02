/**
 * `/workspaces` route handlers — engine-projected (host-owned registry).
 *
 * Implements the v1 `/api/v1/workspaces` wire contract on top of the
 * host-owned `WorkspaceRegistry` (stage 3a) — a plain JSON registry with no
 * v2 `IWorkspaceService`. The Rust engine owns sessions, so `session_count`
 * is derived by counting live engine sessions rooted at the workspace root
 * (`RustSessionService.listSessions`, folding every id spelling of the same
 * root so legacy split buckets count once for the workspace, not per bucket).
 *
 *   GET    /workspaces                    list
 *   POST   /workspaces                    register (idempotent on root)
 *   PATCH  /workspaces/{workspace_id}     rename (display name only)
 *   DELETE /workspaces/{workspace_id}     unregister
 *
 * **Wire fidelity**: the v1 `workspaceSchema` carries more fields than the
 * registry's `WorkspaceRecord` (`{ id, root, name, createdAt, lastOpenedAt }`).
 * The handler projects the record onto the v1 shape, deriving the extra
 * fields:
 *   - `created_at` / `last_opened_at` — from the registry's persisted
 *     timestamps.
 *   - `session_count` — count of live engine sessions for the workspace,
 *     summed across every id spelling of the same root.
 */

import { stat } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

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
import type { RustSessionService } from '../services/rustSession/rustSessionService';
import type { WorkspaceRecord, WorkspaceRegistry } from '../services/workspaceRegistry';

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

export function registerWorkspacesRoutes(
  app: WorkspaceRouteHost,
  rustSession: RustSessionService,
  registry?: WorkspaceRegistry,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces',
      success: { data: listWorkspacesResponseSchema },
      description: 'List registered workspaces',
      tags: ['workspaces'],
    },
    async (req, reply) => {
      if (registry === undefined) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'workspace registry unavailable', req.id),
        );
        return;
      }
      const items = (await registry.list()).map((ws) =>
        toWireWorkspaceRust(ws, rustSessionCount(rustSession, ws.root)),
      );
      reply.send(okEnvelope({ items }, req.id));
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
      try {
        const st = await stat(root);
        if (!st.isDirectory()) {
          reply.send(
            errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `root ${root} is not a directory`, req.id),
          );
          return;
        }
      } catch {
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `root ${root} does not exist`, req.id));
        return;
      }
      if (registry === undefined) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'workspace registry unavailable', req.id),
        );
        return;
      }
      const ws = await registry.createOrTouch(root, req.body.name);
      reply.send(okEnvelope(toWireWorkspaceRust(ws, rustSessionCount(rustSession, ws.root)), req.id));
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
      if (registry === undefined) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'workspace registry unavailable', req.id),
        );
        return;
      }
      try {
        const ws = await registry.rename(workspace_id, req.body.name);
        reply.send(
          okEnvelope(toWireWorkspaceRust(ws, rustSessionCount(rustSession, ws.root)), req.id),
        );
      } catch {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${workspace_id} does not exist`,
            req.id,
          ),
        );
      }
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
      if (registry === undefined) {
        reply.send(
          errEnvelope(ErrorCode.INTERNAL_ERROR, 'workspace registry unavailable', req.id),
        );
        return;
      }
      const deleted = await registry.unregister(workspace_id);
      if (!deleted) {
        reply.send(
          errEnvelope(
            ErrorCode.WORKSPACE_NOT_FOUND,
            `workspace ${workspace_id} does not exist`,
            req.id,
          ),
        );
        return;
      }
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
// Projection — host `WorkspaceRecord` onto the v1 wire `workspaceSchema`.
// ---------------------------------------------------------------------------

/** Rust-engine projection (stage 3a): local registry record → v1 wire. */
function toWireWorkspaceRust(ws: WorkspaceRecord, sessionCount: number): WorkspaceWire {
  return {
    id: ws.id,
    root: ws.root,
    name: ws.name,
    created_at: ws.createdAt,
    last_opened_at: ws.lastOpenedAt,
    session_count: sessionCount,
  };
}

/** Count live engine sessions rooted at `root`. */
function rustSessionCount(rust: RustSessionService, root: string): number {
  return rust
    .listSessions()
    .filter((s) => s.workDir === root || s.workDir.startsWith(`${root}${sep}`))
    .length;
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
