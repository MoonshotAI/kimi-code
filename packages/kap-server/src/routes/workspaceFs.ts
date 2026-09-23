import { isAbsolute } from 'node:path';
import type { Readable } from 'node:stream';

import {
  Error2,
  ErrorCodes,
  HostFolderNotAbsoluteError,
  HostFolderNotFoundError,
  HostFolderPermissionError,
  IHostFileSystem,
  IHostFolderBrowser,
  ISessionIndex,
  IEnvironmentService,
  IWorkspaceService,
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
import { createEnvironmentReadStream, type EnvironmentReadStreamSource } from './fs';
import { sendEnvironmentError } from './environment';

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
      req: {
        id: string;
        query: { path?: string; environment_id?: string; workspace_id?: string; session_id?: string };
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
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description:
        'Serve the raw content of any file on the host filesystem by absolute path. Supports ETag caching and single-range requests. `environment_id` selects the environment filesystem; defaults to local. A non-local `environment_id` is workspace-scoped and requires `workspace_id` or `session_id` to name the workspace.',
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
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PERMISSION_DENIED]: {},
        [ErrorCode.FS_ALREADY_EXISTS]: {},
        [ErrorCode.ENVIRONMENT_NOT_FOUND]: {},
        [ErrorCode.ENVIRONMENT_UNAVAILABLE]: {},
      },
      description:
        'Create a directory on the host filesystem by absolute path (folder-picker "new folder" backend). Non-recursive: the parent directory must already exist. `environment_id` selects the environment filesystem; defaults to local. A non-local `environment_id` is workspace-scoped and requires `workspace_id` or `session_id` to name the workspace.',
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
  workspace_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
});

interface FsContentRequest {
  id: string;
  query: { path: string; environment_id?: string; workspace_id?: string; session_id?: string };
  headers: Record<string, unknown>;
}

interface FsEnvironmentContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

async function acquireFsSource(
  core: Scope,
  environmentId: string,
  context: FsEnvironmentContext,
): Promise<EnvironmentReadStreamSource> {
  if (environmentId === 'local') {
    return {
      hostFs: core.accessor.get(IHostFileSystem),
      lease: { track: (resource) => resource, dispose: () => {} },
    };
  }
  await validateFsContext(core, environmentId, context);
  const lease = core.accessor.get(IEnvironmentService).acquire({ environmentId }, ['fs']);
  return { hostFs: lease.environment.fs!, lease };
}

async function validateFsContext(
  core: Scope,
  environmentId: string,
  context: FsEnvironmentContext,
): Promise<void> {
  if (context.sessionId !== undefined) {
    const summary = await core.accessor.get(ISessionIndex).get(context.sessionId);
    if (summary === undefined) {
      throw new Error2(
        ErrorCodes.SESSION_NOT_FOUND,
        `session ${context.sessionId} does not exist`,
      );
    }
    return;
  }
  if (context.workspaceId !== undefined) {
    const workspace = await core.accessor.get(IWorkspaceService).get(context.workspaceId);
    if (workspace === undefined) throw new Error2(ErrorCodes.WORKSPACE_NOT_FOUND, `workspace ${context.workspaceId} does not exist`);
    return;
  }
  throw new Error2(
    ErrorCodes.VALIDATION_FAILED,
    `pass workspace_id or session_id to identify the request context for environment_id ${environmentId}`,
  );
}

function sendAcquireError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (sendEnvironmentError(reply, requestId, err)) return;
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.VALIDATION_FAILED:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId));
        return;
      case ErrorCodes.SESSION_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
        return;
      case ErrorCodes.WORKSPACE_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.WORKSPACE_NOT_FOUND, err.message, requestId));
        return;
    }
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
    reply.send(
      errEnvelope(ErrorCode.VALIDATION_FAILED, `path must be absolute: ${path}`, requestId),
    );
    return;
  }

  let source: EnvironmentReadStreamSource;
  try {
    source = await acquireFsSource(core, req.query.environment_id ?? 'local', {
      workspaceId: req.query.workspace_id,
      sessionId: req.query.session_id,
    });
  } catch (error) {
    sendAcquireError(reply, requestId, error);
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
      sendOsFsError(reply, requestId, error, path);
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
    } catch (error) {
      sendOsFsError(reply, requestId, error, path);
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
  workspace_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
});

const fsMkdirResponseSchema = z.object({
  path: z.string(),
});

interface FsMkdirRequest {
  id: string;
  body: { path: string; environment_id?: string; workspace_id?: string; session_id?: string };
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
    source = await acquireFsSource(core, req.body.environment_id ?? 'local', {
      workspaceId: req.body.workspace_id,
      sessionId: req.body.session_id,
    });
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
): void {
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `path not found: ${path}`, requestId),
        );
        return;
      case ErrorCodes.OS_FS_ALREADY_EXISTS:
        reply.send(
          errEnvelope(ErrorCode.FS_ALREADY_EXISTS, `path already exists: ${path}`, requestId),
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
