/**
 * `/api/v1/fs::browse` + `/api/v1/fs::home` route handlers — server-v2 port.
 *
 * Mirrors `packages/server/src/routes/workspaceFs.ts` path-for-path: two
 * distinct `GET` routes backed by `agent-core-v2`'s native `IHostFolderBrowser`
 * (Core scope). The domain service already returns the protocol wire shapes
 * (`FsBrowseResponse` / `FsHomeResponse`), so this is a thin adapter that wraps
 * results in the project envelope and translates domain errors to protocol
 * error codes — no `LegacyService` is needed (server-align.md Case A):
 *
 *   - `HostFolderNotAbsoluteError` → 40001 validation.failed
 *   - `HostFolderNotFoundError`    → 40409 fs.path_not_found
 *   - `HostFolderPermissionError`  → 40411 fs.permission_denied
 *
 * Routes (registered exactly as v1 declares them):
 *
 *   GET /fs::browse?path=<abs-path>   list sub-directories (+ git metadata)
 *   GET /fs::home                     $HOME + recent workspace roots
 *
 * **Wire path vs source path.** The source path strings carry a double colon
 * (`/fs::browse`, `/fs::home`) because that is the v1 declaration this mirror
 * must match. Fastify's router (find-my-way) treats the first `:` in a segment
 * as a static/param split, so these registrations are served on the wire as
 * **single-colon** URLs — `/api/v1/fs:browse` and `/api/v1/fs:home`. That is
 * byte-for-byte the v1 contract (see `packages/protocol/src/rest/fsBrowse.ts`,
 * which documents `GET /v1/fs:browse` / `GET /v1/fs:home`). A single
 * `/fs:action` parametric dispatcher is NOT a faithful mirror: it accepts the
 * double-colon URL that v1 404s on and rejects the single-colon URL v1 serves.
 */

import {
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFolderBrowser,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface WorkspaceFsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: { path?: string } },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

export function registerWorkspaceFsRoutes(app: WorkspaceFsRouteHost, core: Scope): void {
  const browseRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::browse',
      querystring: fsBrowseQuerySchema,
      success: { data: fsBrowseResponseSchema },
      description: 'Browse local directories (server folder picker backend)',
      tags: ['workspaces'],
      operationId: 'fsBrowse',
    },
    async (req, reply) => {
      try {
        const data = await core.accessor.get(IHostFolderBrowser).browse(req.query.path);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    browseRoute.path,
    browseRoute.options,
    browseRoute.handler as Parameters<WorkspaceFsRouteHost['get']>[2],
  );

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
        const data = await core.accessor.get(IHostFolderBrowser).home();
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.get(
    homeRoute.path,
    homeRoute.options,
    homeRoute.handler as Parameters<WorkspaceFsRouteHost['get']>[2],
  );
}

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof HostFolderNotAbsoluteError) {
    reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
    return;
  }
  if (err instanceof HostFolderNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
    return;
  }
  if (err instanceof HostFolderPermissionError) {
    reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, err.message, requestId, err.stack));
    return;
  }
  throw err;
}
