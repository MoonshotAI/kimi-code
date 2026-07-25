/**
 * `/api/v1/fs::browse` + `/api/v1/fs::home` + `/api/v1/fs::content` route
 * handlers — server-v2 port.
 *
 * The folder-picker pair mirrors `packages/server/src/routes/workspaceFs.ts`
 * path-for-path: two distinct `GET` routes backed by `agent-core-v2`'s native
 * `IHostFolderBrowser` (Core scope), translating its domain errors to wire
 * codes (server-align.md Case A):
 *
 *   - `HostFolderNotAbsoluteError` → 40001 validation.failed
 *   - `HostFolderNotFoundError`    → 40409 fs.path_not_found
 *   - `HostFolderPermissionError`  → 40411 fs.permission_denied
 *
 * `fs::content` is a server-v2 addition with no v1 counterpart: it serves ANY
 * absolute path on the host as a raw byte stream, so the global bearer auth
 * is its only access gate. The response is plain file content (no envelope)
 * with a best-effort `Content-Type`, `ETag` / `If-None-Match` caching, and
 * single-range `Range` support — the same serving semantics as the session
 * `fs/{path}:download` route, so browsers can render previews directly.
 * All file handling lives here in the transport layer on top of the os
 * `IHostFileSystem` primitives — the engine deliberately has no "unconfined
 * read" domain Service. The mime / etag helpers are shared with the engine's
 * `sessionFs` via `agent-core-v2/_base/utils/fileMeta` so both surfaces label
 * content the same way. `IHostFileSystem` failures arrive as coded `os.fs.*`
 * errors and are mapped here:
 *
 *   - not absolute                        → 40001 validation.failed
 *   - `os.fs.not_found` / `not_directory` → 40409 fs.path_not_found
 *   - `os.fs.permission_denied`           → 40411 fs.permission_denied
 *   - directory target                    → 40906 fs.is_directory
 *
 * Routes:
 *
 *   GET /fs::browse?path=<abs-path>    list sub-directories (v1 mirror)
 *   GET /fs::home                      $HOME + recent workspace roots (v1 mirror)
 *   GET /fs::content?path=<abs-path>   raw content of any host file (server-v2 addition)
 *
 * **Wire path vs source path.** The source path strings carry a double colon
 * (`/fs::browse`, `/fs::home`) because that is the v1 declaration this mirror
 * must match. Fastify's router (find-my-way) treats the first `:` in a segment
 * as a static/param split, so these registrations are served on the wire as
 * **single-colon** URLs — `/api/v1/fs:browse` and `/api/v1/fs:home`. That is
 * byte-for-byte the v1 contract (see `packages/protocol/src/rest/fsBrowse.ts`,
 * which documents `GET /v1/fs:browse` / `GET /v1/fs:home`). `/fs::content`
 * follows the same single-colon wire convention. A single `/fs:action`
 * parametric dispatcher is NOT a faithful mirror: it accepts the double-colon
 * URL that v1 404s on and rejects the single-colon URL v1 serves.
 */

import { createReadStream, type ReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';

import {
  ErrorCodes,
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFileSystem,
  IHostFolderBrowser,
  isError2,
  type HostFileStat,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  fsBrowseQuerySchema,
  fsBrowseResponseSchema,
  fsHomeResponseSchema,
} from '@moonshot-ai/agent-core-v2/app/hostFolderBrowser/hostFolderBrowser';
import {
  buildEtag,
  detectBinary,
  FS_BINARY_SAMPLE_BYTES,
  guessMime,
} from '@moonshot-ai/agent-core-v2/_base/utils/fileMeta';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';

interface FsContentReply {
  type(mime: string): FsContentReply;
  header(name: string, value: string | number): FsContentReply;
  code(status: number): FsContentReply;
  send(payload: unknown): unknown;
}

interface WorkspaceFsRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; query: { path?: string }; headers: Record<string, unknown> },
      reply: FsContentReply,
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
    browseRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
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
    homeRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
  );

  const contentRoute = defineRoute(
    {
      method: 'GET',
      path: '/fs::content',
      querystring: fsContentQuerySchema,
      rawResponse: {
        200: { type: 'string', format: 'binary' },
        206: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
      },
      description:
        'Serve the raw content of any file on the host filesystem by absolute path. Supports ETag caching and single-range requests.',
      tags: ['workspaces'],
      operationId: 'fsContent',
    },
    async (req, reply) => {
      return handleFsContent(core, req, reply as unknown as FsContentReply);
    },
  );
  app.get(
    contentRoute.path,
    contentRoute.options,
    contentRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// fs:content — host-side arbitrary file serving, implemented in the transport layer.
// ---------------------------------------------------------------------------

const fsContentQuerySchema = z.object({
  path: z.string().min(1),
});

interface FsContentRequest {
  id: string;
  query: { path: string };
  headers: Record<string, unknown>;
}

async function handleFsContent(
  core: Scope,
  req: FsContentRequest,
  reply: FsContentReply,
): Promise<void> {
  const requestId = req.id;
  const { path } = req.query;
  if (!isAbsolute(path)) {
    reply.send(
      errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, requestId),
    );
    return;
  }

  const hostFs = core.accessor.get(IHostFileSystem);

  let abs: string;
  let st: HostFileStat;
  try {
    abs = await hostFs.realpath(path);
    st = await hostFs.stat(abs);
  } catch (err) {
    sendOsFsError(reply, requestId, err, path);
    return;
  }

  if (st.isDirectory) {
    reply.send(
      errEnvelope(ErrorCode.FS_IS_DIRECTORY, `path is a directory: ${path}`, requestId),
    );
    return;
  }
  // Only regular files are served: device nodes (/dev/zero streams forever),
  // FIFOs (reads block), sockets, and /proc-style zero-size virtual files
  // would otherwise hang or produce malformed responses.
  if (!st.isFile) {
    reply.send(
      errEnvelope(
        ErrorCode.VALIDATION_FAILED,
        `path is not a regular file: ${path}`,
        requestId,
      ),
    );
    return;
  }

  // Sample the leading bytes only to refine the mime fallback for unknown
  // extensions (octet-stream vs text/plain), mirroring session fs downloads.
  let isBinary = false;
  try {
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await hostFs.readBytes(abs, sampleSize);
    isBinary = detectBinary(sample);
  } catch (err) {
    sendOsFsError(reply, requestId, err, path);
    return;
  }

  const etag = buildEtag(st);
  const ifNoneMatch = pickHeader(req.headers, 'if-none-match');
  if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
    reply.code(304).header('etag', etag).send('');
    return;
  }

  reply.header('etag', etag);
  reply.header('last-modified', new Date(st.mtimeMs ?? 0).toUTCString());
  reply.type(guessMime(abs, isBinary));

  const log = requestLog(req);
  const onStreamError = (stream: ReadStream) => (error: unknown) => {
    log?.warn({ path, err: error }, 'fs content stream error');
    try {
      stream.destroy();
    } catch {
      // best-effort
    }
  };

  const range = parseRangeHeader(pickHeader(req.headers, 'range'), st.size);
  if (range !== null) {
    reply
      .code(206)
      .header('content-length', String(range.length))
      .header('content-range', `bytes ${range.start}-${range.end}/${st.size}`);
    const stream = createReadStream(abs, { start: range.start, end: range.end });
    stream.on('error', onStreamError(stream));
    return reply.send(stream) as unknown as void;
  }

  reply.code(200).header('content-length', String(st.size));
  const stream = createReadStream(abs);
  stream.on('error', onStreamError(stream));
  return reply.send(stream) as unknown as void;
}

/** Map a coded `os.fs.*` failure from `IHostFileSystem` onto the wire codes. */
function sendOsFsError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
  path: string,
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path not found: ${path}`, requestId),
        );
        return;
      case ErrorCodes.OS_FS_PERMISSION_DENIED:
        reply.send(
          errEnvelope(ErrorCode.FS_PERMISSION_DENIED, `permission denied: ${path}`, requestId),
        );
        return;
    }
  }
  throw err;
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
