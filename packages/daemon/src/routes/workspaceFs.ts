/**
 * `/fs:browse` + `/fs:home` REST routes (daemon-OWN folder picker).
 *
 * **URL convention**: find-my-way's `::` escape collapses the two colons
 * into a literal `:` STATIC path segment. The Fastify routes therefore
 * use the literal-colon form `'/fs::browse'` + `'/fs::home'` — each
 * registers as a single static path that matches a request for
 * `/fs:browse` / `/fs:home` exactly. See REST.md §3 (`:action` URL
 * convention).
 *
 * Endpoints:
 *
 *   GET /fs:browse?path=<abs>  → FsBrowseResponse
 *   GET /fs:home               → FsHomeResponse
 *
 * **Error mapping**:
 *   - `WorkspaceFsNotAbsoluteError`   → envelope `code: 40001`
 *   - `WorkspaceFsNotFoundError`      → envelope `code: 40409`
 *   - `WorkspaceFsPermissionError`    → envelope `code: 40411`
 *   - other errors                    → global hook (→ 50001)
 */

import {
  ErrorCode,
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '@moonshot-ai/protocol';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  IWorkspaceFsService,
  WorkspaceFsNotAbsoluteError,
  WorkspaceFsNotFoundError,
  WorkspaceFsPermissionError,
} from '#/services/workspace';

interface WorkspaceFsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerWorkspaceFsRoutes(
  app: WorkspaceFsRouteHost,
  ix: IInstantiationService,
): void {
  // GET /fs:browse  → registered as the static literal `/fs::browse`
  // because find-my-way's `::` escape collapses to a literal `:`.
  const browseRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::browse',
      querystring: fsBrowseQuerySchema,
      success: { data: fsBrowseResponseSchema },
      description: 'Browse local directories (daemon folder picker backend)',
      tags: ['workspaces'],
      operationId: 'fsBrowse',
    },
    async (req, reply) => {
      try {
        const query = req.query;
        const data = await ix.invokeFunction((a) =>
          a.get(IWorkspaceFsService).browse(query.path),
        );
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(browseRoute.path, browseRoute.options, browseRoute.handler as Parameters<WorkspaceFsRouteHost['get']>[2]);

  // GET /fs:home  → registered as the static literal `/fs::home`.
  const homeRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::home',
      success: { data: fsHomeResponseSchema },
      description: 'Folder picker landing payload: $HOME + recent workspace roots',
      tags: ['workspaces'],
      operationId: 'fsHome',
    },
    async (req, reply) => {
      try {
        const data = await ix.invokeFunction((a) => a.get(IWorkspaceFsService).home());
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(homeRoute.path, homeRoute.options, homeRoute.handler as Parameters<WorkspaceFsRouteHost['get']>[2]);
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof WorkspaceFsNotAbsoluteError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
    return;
  }
  if (err instanceof WorkspaceFsNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof WorkspaceFsPermissionError) {
    reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, err.message, requestId));
    return;
  }
  throw err;
}
