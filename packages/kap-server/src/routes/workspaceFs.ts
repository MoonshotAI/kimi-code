import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
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
  FS_BINARY_SAMPLE_BYTES,
  guessMime,
} from '@moonshot-ai/agent-core-v2/_base/utils/fileMeta';
import { classifyTextSample } from '@moonshot-ai/agent-core-v2/_base/text/encoding';
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
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: { id: string; body: unknown },
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

  const mkdirRoute = defineRoute(
    {
      method: 'POST',
      path: '/fs::mkdir',
      body: fsMkdirBodySchema,
      success: { data: fsMkdirResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_ALREADY_EXISTS]: {},
      },
      description:
        'Create a directory on the host filesystem by absolute path (folder-picker "new folder" backend). Non-recursive: the parent directory must already exist.',
      tags: ['workspaces'],
      operationId: 'fsMkdir',
    },
    async (req, reply) => {
      return handleFsMkdir(req, reply);
    },
  );
  app.post(
    mkdirRoute.path,
    mkdirRoute.options,
    mkdirRoute.handler as unknown as Parameters<WorkspaceFsRouteHost['post']>[2],
  );
}

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

  let isBinary = false;
  try {
    const sampleSize = Math.min(FS_BINARY_SAMPLE_BYTES, st.size);
    const sample =
      sampleSize === 0 ? new Uint8Array() : await hostFs.readBytes(abs, sampleSize);
    const classification = classifyTextSample(sample);
    isBinary = classification.isBinary || classification.encoding !== 'utf-8';
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

const fsMkdirBodySchema = z.object({
  path: z.string().min(1),
});

const fsMkdirResponseSchema = z.object({
  path: z.string(),
});

interface FsMkdirRequest {
  id: string;
  body: { path: string };
}

async function handleFsMkdir(
  req: FsMkdirRequest,
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const requestId = req.id;
  const { path } = req.body;
  if (!isAbsolute(path)) {
    reply.send(
      errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, requestId),
    );
    return;
  }

  try {
    await mkdir(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    switch (code) {
      case 'EEXIST':
        reply.send(
          errEnvelope(ErrorCode.FS_ALREADY_EXISTS, `path already exists: ${path}`, requestId),
        );
        return;
      case 'ENOENT':
      case 'ENOTDIR':
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `parent path not found: ${path}`, requestId),
        );
        return;
      case 'EACCES':
      case 'EPERM':
        reply.send(
          errEnvelope(ErrorCode.FS_PERMISSION_DENIED, `permission denied: ${path}`, requestId),
        );
        return;
    }
    throw err;
  }

  reply.send(okEnvelope({ path }, requestId));
}

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
