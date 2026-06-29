/**
 * `/fs::browse` and `/fs::home` route handlers — server-v2 port.
 *
 * Implements the v1 folder-picker wire contract on top of `agent-core-v2`'s
 * `IHostFolderBrowser` (Core scope). The domain service owns the filesystem
 * work and returns protocol-shaped payloads; this module is a thin facade
 * that wraps results in the project envelope and translates domain errors to
 * protocol error codes:
 *
 *   - `HostFolderNotAbsoluteError` → 40001 validation.failed
 *   - `HostFolderNotFoundError`    → 40409 fs.path_not_found
 *   - `HostFolderPermissionError`  → 40411 fs.permission_denied
 *
 *   GET /fs::browse?path=<abs-path>   list sub-directories (+ git metadata)
 *   GET /fs::home                     $HOME + recent workspace roots
 *
 * **Why a single `/fs:action` semi-static route?** find-my-way (Fastify's
 * router) treats `:` as a parameter marker, so the literal v1 paths
 * `/fs::browse` / `/fs::home` cannot be registered directly — they collapse
 * into an unmatchable `/fs:browse` node. Registering `/fs:action` (static
 * prefix `fs` + `action` parameter) lets `/fs::browse` arrive with
 * `params.action === '::browse'`, which we dispatch on here.
 */

import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFolderBrowser,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  ErrorCode,
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '@moonshot-ai/protocol';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';

const fsActionParamsSchema = z.object({ action: z.string() });

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

interface WorkspaceFsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; params: { action: string }; query: { path?: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerWorkspaceFsRoutes(app: WorkspaceFsRouteHost, core: Scope): void {
  const route = defineRoute(
    {
      method: 'GET',
      path: '/fs:action',
      params: fsActionParamsSchema,
      querystring: fsBrowseQuerySchema,
      success: { data: z.union([fsBrowseResponseSchema, fsHomeResponseSchema]) },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
      },
      description:
        'Folder picker backend. Use GET /fs::browse?path=<abs-path> to list sub-directories, or GET /fs::home for $HOME + recent workspace roots.',
      tags: ['workspaces'],
      operationId: 'fsAction',
    },
    async (req, reply) => {
      const action = req.params.action;
      if (action !== '::browse' && action !== '::home') {
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `unknown fs action: ${action}`, req.id));
        return;
      }
      try {
        const browser = core.accessor.get(IHostFolderBrowser);
        const data =
          action === '::browse'
            ? await browser.browse(req.query.path)
            : await browser.home();
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(route.path, route.options, route.handler as Parameters<WorkspaceFsRouteHost['get']>[2]);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof HostFolderNotAbsoluteError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
    return;
  }
  if (err instanceof HostFolderNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof HostFolderPermissionError) {
    reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, err.message, requestId));
    return;
  }
  throw err;
}
