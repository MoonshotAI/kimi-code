import {
  ErrorCode,
  createWorktreeRequestSchema,
  createWorktreeResponseSchema,
  listWorktreesResponseSchema,
  openWorktreeInAppRequestSchema,
  openWorktreeInAppResponseSchema,
  removeWorktreeRequestSchema,
  removeWorktreeResponseSchema,
  workspaceIdParamSchema,
} from '@moonshot-ai/protocol';

import {
  IWorktreeService,
  WorktreeConflictError,
  WorktreeError,
  WorktreeGitUnavailableError,
  WorktreeNotFoundError,
  WorkspaceNotFoundError,
  type IInstantiationService,
} from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { launchDetached, openInAppCommandFor } from '../lib/fileLaunch';
import { defineRoute } from '../middleware/defineRoute';

interface WorktreeRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: unknown },
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
}

export function registerWorktreesRoutes(
  app: WorktreeRouteHost,
  ix: IInstantiationService,
): void {
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/worktrees',
      params: workspaceIdParamSchema,
      success: { data: listWorktreesResponseSchema },
      description: 'List git worktrees of a workspace repository',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      try {
        const worktrees = await ix.invokeFunction((a) =>
          a.get(IWorktreeService).list(req.params.workspace_id),
        );
        reply.send(okEnvelope({ worktrees }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<WorktreeRouteHost['get']>[2],
  );

  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/worktrees',
      params: workspaceIdParamSchema,
      body: createWorktreeRequestSchema,
      success: { data: createWorktreeResponseSchema },
      description: 'Create a git worktree (and branch) in a workspace repository',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      try {
        const worktree = await ix.invokeFunction((a) =>
          a.get(IWorktreeService).create(req.params.workspace_id, req.body),
        );
        reply.send(okEnvelope(worktree, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
  );

  const removeRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/worktrees/remove',
      params: workspaceIdParamSchema,
      body: removeWorktreeRequestSchema,
      success: { data: removeWorktreeResponseSchema },
      description: 'Remove a git worktree from a workspace repository',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      try {
        await ix.invokeFunction((a) =>
          a.get(IWorktreeService).remove(req.params.workspace_id, req.body),
        );
        reply.send(okEnvelope({ removed: true as const }, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );

  app.post(
    removeRoute.path,
    removeRoute.options,
    removeRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
  );

  const openInRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/worktrees/open-in',
      params: workspaceIdParamSchema,
      body: openWorktreeInAppRequestSchema,
      success: { data: openWorktreeInAppResponseSchema },
      description: 'Open a worktree folder in an external application (Cursor, VS Code, Finder, etc.)',
      tags: ['worktrees'],
    },
    async (req, reply) => {
      let targetPath: string;
      try {
        const worktrees = await ix.invokeFunction((a) =>
          a.get(IWorktreeService).list(req.params.workspace_id),
        );
        const target = worktrees.find((w) => w.path === req.body.path);
        if (!target) {
          throw new WorktreeNotFoundError(req.body.path);
        }
        targetPath = target.path;
      } catch (err) {
        sendMappedError(reply, req.id, err);
        return;
      }
      try {
        await launchDetached(
          openInAppCommandFor(req.body.app_id, targetPath, { isDirectory: true }),
        );
      } catch (err) {
        reply.send(
          errEnvelope(
            ErrorCode.INTERNAL_ERROR,
            `failed to open in ${req.body.app_id}: ${err instanceof Error ? err.message : String(err)}`,
            req.id,
          ),
        );
        return;
      }
      reply.send(okEnvelope({ opened: true as const }, req.id));
    },
  );

  app.post(
    openInRoute.path,
    openInRoute.options,
    openInRoute.handler as Parameters<WorktreeRouteHost['post']>[2],
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
  if (err instanceof WorktreeGitUnavailableError) {
    reply.send(errEnvelope(ErrorCode.FS_GIT_UNAVAILABLE, err.message, requestId));
    return;
  }
  if (err instanceof WorktreeNotFoundError) {
    reply.send(errEnvelope(ErrorCode.WORKTREE_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof WorktreeConflictError) {
    reply.send(errEnvelope(ErrorCode.WORKTREE_CONFLICT, err.message, requestId));
    return;
  }
  if (err instanceof WorktreeError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
    return;
  }
  throw err;
}
