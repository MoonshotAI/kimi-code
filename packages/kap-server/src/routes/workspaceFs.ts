import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';

import {
  ErrorCodes,
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IBootstrapService,
  IHostFileSystem,
  IHostFolderBrowser,
  IEnvironmentService,
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
import { sendRawError } from '../lib/rawError';
import { requestLog } from '../lib/requestLog';
import { defineRoute, httpErrorSchema } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import { createEnvironmentReadStream, type EnvironmentReadStreamSource } from './fs';
import { sendEnvironmentError } from './environment';
import { EDITABLE_FILE_MAX_BYTES, FileWriteError, WritableHostFiles } from '../services/writableHostFiles';
import type { FastifyInstance } from 'fastify';

interface FsContentReply {
  type(mime: string): FsContentReply;
  header(name: string, value: string | number): FsContentReply;
  code(status: number): FsContentReply;
  send(payload: unknown): unknown;
}

interface WorkspaceFsRouteHost extends Pick<FastifyInstance, 'register'> {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> } | undefined,
    handler: (
      req: {
        id: string;
        query: { path?: string; environment_id?: string };
        headers: Record<string, unknown>;
      },
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
      } catch (error) {
        sendMappedError(reply, req.id, error);
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
      } catch (error) {
        sendMappedError(reply, req.id, error);
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
      rawErrorStatus: true,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description:
        'Serve the raw content of any file on the host filesystem by absolute path. Supports ETag caching and single-range requests. `environment_id` selects the filesystem of a shared app-level environment; defaults to local.',
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

  const writable = new WritableHostFiles(core.accessor.get(IBootstrapService).homeDir);
  app.register(async (scope) => {
    scope.setErrorHandler((error, req, reply) => {
      if (error instanceof Error && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
        return sendRawError(reply, errEnvelope(ErrorCode.FS_TOO_LARGE, 'File exceeds the edit size limit', req.id));
      }
      throw error;
    });
    scope.addContentTypeParser('text/plain', { parseAs: 'buffer' }, (_req, bytes: Buffer, done) => {
      try {
        done(null, new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
      } catch {
        done(Object.assign(new Error('Expected valid UTF-8 text'), { statusCode: 400 }));
      }
    });
    const route = defineRoute({
      method: 'PUT', path: '/fs::content', consumes: ['text/plain'], body: z.string(),
      querystring: fsContentQuerySchema.extend({ revision: z.union([z.literal('missing'), z.string().regex(/^[0-9a-f]{64}$/)]) }).strict(),
      success: { data: z.object({ revision: z.string() }) },
      errors: { [ErrorCode.VALIDATION_FAILED]: {}, [ErrorCode.INTERNAL_ERROR]: {} },
      rawResponse: {
        400: httpErrorSchema(ErrorCode.VALIDATION_FAILED),
        403: httpErrorSchema(ErrorCode.FS_WRITE_NOT_ALLOWED),
        412: httpErrorSchema(ErrorCode.FS_CONTENT_CHANGED),
        413: httpErrorSchema(ErrorCode.FS_TOO_LARGE),
      },
      description: 'Create or replace an allowlisted UTF-8 host file. Supply the SHA-256 of the bytes read, or missing to create only.',
      tags: ['workspaces'], operationId: 'writeFsContent',
    }, async (req, reply) => {
      const fail = (code: ErrorCode, message: string) => sendRawError(reply as FsContentReply, errEnvelope(code, message, req.id));
      const mediaType = pickHeader(req.headers, 'content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mediaType !== 'text/plain' || req.body.includes('\0')) return void fail(ErrorCode.VALIDATION_FAILED, 'Expected a text/plain UTF-8 file');
      if (req.query.environment_id !== undefined && req.query.environment_id !== 'local') return void fail(ErrorCode.FS_WRITE_NOT_ALLOWED, 'Remote environment writes are not allowed');
      try {
        reply.send(okEnvelope(await writable.replace(req.query.path, req.body, req.query.revision), req.id));
      } catch (err) {
        if (err instanceof FileWriteError) return void fail(err.code, err.message);
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return void fail(ErrorCode.FS_CONTENT_CHANGED, 'File is no longer present');
        if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return void fail(ErrorCode.FS_WRITE_NOT_ALLOWED, 'Writing this file is not allowed');
        throw err;
      }
    });
    scope.put(route.path, { ...route.options, preHandler: route.options.preHandler as never, bodyLimit: EDITABLE_FILE_MAX_BYTES }, route.handler as never);
  });

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
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description:
        'Create a directory on the host filesystem by absolute path (folder-picker "new folder" backend). Non-recursive: the parent directory must already exist. `environment_id` selects the filesystem of a shared app-level environment; defaults to local.',
      tags: ['workspaces'],
      operationId: 'fsMkdir',
    },
    async (req, reply) => {
      return handleFsMkdir(core, req, reply);
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
  environment_id: z.string().min(1).optional(),
});

interface FsContentRequest {
  id: string;
  query: { path: string; environment_id?: string };
  headers: Record<string, unknown>;
}

async function acquireFsSource(
  core: Scope,
  environmentId: string,
): Promise<EnvironmentReadStreamSource> {
  if (environmentId === 'local') {
    return {
      hostFs: core.accessor.get(IHostFileSystem),
      lease: { track: (resource) => resource, dispose: () => {} },
    };
  }
  const lease = core.accessor.get(IEnvironmentService).acquire({ environmentId }, ['fs']);
  return { hostFs: lease.environment.fs!, lease };
}

function sendAcquireError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
  rawResponse = false,
): void {
  if (rawResponse) {
    const rawReply = reply as FsContentReply;
    reply = {
      send: (payload) => sendRawError(rawReply, payload as { code: ErrorCode }),
    };
  }
  if (sendEnvironmentError(reply, requestId, err)) return;
  if (rawResponse) {
    sendRawError(
      reply as FsContentReply,
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return;
  }
  throw err;
}

async function handleFsContent(
  core: Scope,
  req: FsContentRequest,
  reply: FsContentReply,
): Promise<void> {
  const requestId = req.id;
  const { path } = req.query;
  if (!isAbsolute(path)) {
    sendRawError(
      reply,
      errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, requestId),
    );
    return;
  }

  let source: EnvironmentReadStreamSource;
  try {
    source = await acquireFsSource(core, req.query.environment_id ?? 'local');
  } catch (error) {
    sendAcquireError(reply, requestId, error, true);
    return;
  }

  let streaming = false;
  try {
    const hostFs = source.hostFs;

    let abs: string;
    let st: HostFileStat;
    try {
      abs = await hostFs.realpath(path);
      st = await hostFs.stat(abs);
    } catch (error) {
      sendOsFsError(reply, requestId, error, path, true);
      return;
    }

    if (st.isDirectory) {
      sendRawError(
        reply,
        errEnvelope(ErrorCode.FS_IS_DIRECTORY, `path is a directory: ${path}`, requestId),
      );
      return;
    }
    if (!st.isFile) {
      sendRawError(
        reply,
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
    } catch (error) {
      sendOsFsError(reply, requestId, error, path, true);
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
    const onStreamError = (stream: Readable) => (error: unknown) => {
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
      const stream = createEnvironmentReadStream(source, abs, range.start, range.length);
      streaming = true;
      stream.on('error', onStreamError(stream));
      return reply.send(stream) as unknown as void;
    }

    reply.code(200).header('content-length', String(st.size));
    const stream = createEnvironmentReadStream(source, abs, 0, st.size);
    streaming = true;
    stream.on('error', onStreamError(stream));
    return reply.send(stream) as unknown as void;
  } finally {
    if (!streaming) source.lease.dispose();
  }
}

const fsMkdirBodySchema = z.object({
  path: z.string().min(1),
  environment_id: z.string().min(1).optional(),
});

const fsMkdirResponseSchema = z.object({
  path: z.string(),
});

interface FsMkdirRequest {
  id: string;
  body: { path: string; environment_id?: string };
}

async function handleFsMkdir(
  core: Scope,
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

  let source: EnvironmentReadStreamSource;
  try {
    source = await acquireFsSource(core, req.body.environment_id ?? 'local');
  } catch (error) {
    sendAcquireError(reply, requestId, error);
    return;
  }

  try {
    await source.hostFs.mkdir(path);
  } catch (error) {
    sendOsFsError(reply, requestId, error, path);
    return;
  } finally {
    source.lease.dispose();
  }

  reply.send(okEnvelope({ path }, requestId));
}

function sendOsFsError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
  path: string,
  rawResponse = false,
): void {
  const send = (envelope: { code: number }): unknown =>
    rawResponse ? sendRawError(reply as FsContentReply, envelope) : reply.send(envelope);
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path not found: ${path}`, requestId));
        return;
      case ErrorCodes.OS_FS_ALREADY_EXISTS:
        send(errEnvelope(ErrorCode.FS_ALREADY_EXISTS, `path already exists: ${path}`, requestId));
        return;
      case ErrorCodes.OS_FS_PERMISSION_DENIED:
        send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, `permission denied: ${path}`, requestId));
        return;
    }
  }
  if (rawResponse) {
    send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        err instanceof Error ? err.message : String(err),
        requestId,
        err instanceof Error ? err.stack : undefined,
      ),
    );
    return;
  }
  throw err;
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
