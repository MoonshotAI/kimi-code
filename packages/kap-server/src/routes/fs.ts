/**
 * `/api/v1` session filesystem routes — server-v2 port.
 *
 * Mirrors `packages/server/src/routes/fs.ts` path-for-path and schema-for-schema
 * so existing v1 clients keep working against server-v2. Backed by the v2
 * Session-scoped `ISessionFsService` (`agent-core-v2/src/sessionFs`): the route resolves
 * the session from the URL, then dispatches `fs:<action>` to the matching
 * `ISessionFsService` method. The wire schema comes from the engine's own
 * `sessionFs` domain contract (`agent-core-v2`).
 */

import { createReadStream } from 'node:fs';

import {
  ErrorCodes,
  ISessionFsService,
  ISessionLifecycleService,
  isError2,
  Error2,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import {
  fsDiffRequestSchema,
  fsGitStatusRequestSchema,
  fsGrepRequestSchema,
  fsListManyRequestSchema,
  fsListRequestSchema,
  fsMkdirRequestSchema,
  fsReadRequestSchema,
  fsSearchRequestSchema,
  fsStatManyRequestSchema,
  fsStatRequestSchema,
} from '@moonshot-ai/agent-core-v2/session/sessionFs/fs';
import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import {
  launchDetached,
  openFileCommandFor,
  openInAppCommandFor,
  revealFileCommandFor,
} from '../lib/fileLaunch';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  fsOpenInRequestSchema,
  fsOpenRequestSchema,
  fsRevealRequestSchema,
} from '../protocol/rest-fs';

interface FsRouteHost {
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
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; headers: Record<string, unknown> },
      reply: FsDownloadReply,
    ) => unknown,
  ): unknown;
}

interface FsDownloadReply {
  type(mime: string): FsDownloadReply;
  header(name: string, value: string | number): FsDownloadReply;
  code(status: number): FsDownloadReply;
  send(payload: unknown): unknown;
}

const sessionIdAndTailParamSchema = z.object({
  session_id: z.string().min(1),
  tail: z.string().min(1),
});

const FS_ACTIONS = [
  'list',
  'read',
  'list_many',
  'stat',
  'stat_many',
  'mkdir',
  'search',
  'grep',
  'git_status',
  'diff',
  'open',
  'open-in',
  'reveal',
] as const;
type FsAction = (typeof FS_ACTIONS)[number];
const FS_TAIL_PREFIX = 'fs:';

function resolveFs(core: Scope, sessionId: string): ISessionFsService {
  const session = core.accessor.get(ISessionLifecycleService).get(sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  return session.accessor.get(ISessionFsService);
}

export function registerFsRoutes(app: FsRouteHost, core: Scope): void {
  const fsActionRoute = defineRoute(
    {
      method: 'POST',
      path: '/sessions/{session_id}/{tail}',
      params: sessionIdAndTailParamSchema,
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_IS_DIRECTORY]: {},
        [ErrorCode.FS_IS_BINARY]: {},
        [ErrorCode.FS_TOO_LARGE]: {},
        [ErrorCode.FS_TOO_MANY_RESULTS]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
        [ErrorCode.FS_GREP_TIMEOUT]: {},
        [ErrorCode.FS_GIT_UNAVAILABLE]: {},
        [ErrorCode.FS_ALREADY_EXISTS]: {},
      },
      description:
        'Filesystem action dispatcher. Supported actions: list, read, list_many, stat, stat_many, mkdir, search, grep, git_status, diff, open, open-in, reveal.',
      tags: ['fs'],
      operationId: 'fsAction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params as { session_id: string; tail: string };

      if (!tail.startsWith(FS_TAIL_PREFIX)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }

      const action = tail.slice(FS_TAIL_PREFIX.length);
      if (!(FS_ACTIONS as readonly string[]).includes(action)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${tail}`, req.id),
        );
        return;
      }
      const fsAction = action as FsAction;

      // Cold-load a persisted-but-not-live session so fs actions (which only
      // need the work dir) do not 404 on a freshly-opened session. Matches v1,
      // which reads the persisted cwd. `resume` returns undefined only when the
      // session is unknown or its workspace is gone.
      const session = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }

      try {
        switch (fsAction) {
          case 'list':
            await handleList(core, session_id, req, reply);
            return;
          case 'read':
            await handleRead(core, session_id, req, reply);
            return;
          case 'list_many':
            await handleListMany(core, session_id, req, reply);
            return;
          case 'stat':
            await handleStat(core, session_id, req, reply);
            return;
          case 'stat_many':
            await handleStatMany(core, session_id, req, reply);
            return;
          case 'mkdir':
            await handleMkdir(core, session_id, req, reply);
            return;
          case 'search':
            await handleSearch(core, session_id, req, reply);
            return;
          case 'grep':
            await handleGrep(core, session_id, req, reply);
            return;
          case 'git_status':
            await handleGitStatus(core, session_id, req, reply);
            return;
          case 'diff':
            await handleDiff(core, session_id, req, reply);
            return;
          case 'open':
            await handleOpen(core, session_id, req, reply);
            return;
          case 'open-in':
            await handleOpenIn(core, session_id, req, reply);
            return;
          case 'reveal':
            await handleReveal(core, session_id, req, reply);
            return;
        }
      } catch (err) {
        sendMappedError(reply, req, err);
      }
    },
  );
  app.post(
    fsActionRoute.path,
    fsActionRoute.options,
    fsActionRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  const downloadRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/fs/*',
      rawResponse: {
        200: { type: 'string', format: 'binary' },
      },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.SESSION_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_NOT_FOUND]: {},
        [ErrorCode.FS_PATH_ESCAPES_SESSION]: {},
      },
      description: 'Download a file from the session workspace',
      tags: ['fs'],
      operationId: 'downloadFile',
    },
    async (req, reply) => {
      const { session_id } = req.params as { session_id: string };
      const wildcard = (req.params as Record<string, unknown>)['*'] as string;

      const DOWNLOAD_SUFFIX = ':download';
      if (!wildcard.endsWith(DOWNLOAD_SUFFIX)) {
        reply.send(
          errEnvelope(ErrorCode.VALIDATION_FAILED, `unsupported action: ${wildcard}`, req.id),
        );
        return;
      }
      const relPath = wildcard.slice(0, -DOWNLOAD_SUFFIX.length);
      if (relPath.length === 0) {
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'path is empty', req.id));
        return;
      }

      // Cold-load so a freshly-opened (persisted but not live) session can still
      // serve downloads; `resume` only returns undefined for unknown / workspace-gone.
      const session = await core.accessor.get(ISessionLifecycleService).resume(session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }

      let resolved: Awaited<ReturnType<ISessionFsService['resolveDownload']>>;
      try {
        resolved = await resolveFs(core, session_id).resolveDownload(relPath);
      } catch (err) {
        sendMappedError(reply, req, err);
        return;
      }

      const r = reply as unknown as FsDownloadReply;
      const headers = req.headers;

      const ifNoneMatch = pickHeader(headers, 'if-none-match');
      if (ifNoneMatch !== undefined && ifNoneMatch === resolved.etag) {
        r.code(304).header('etag', resolved.etag).send('');
        return;
      }

      r.header('etag', resolved.etag);
      r.header('last-modified', resolved.modifiedAt.toUTCString());
      r.header(
        'content-disposition',
        `attachment; filename="${sanitizeFilename(resolved.relative)}"`,
      );
      r.type(resolved.mime);

      const rangeHeader = pickHeader(headers, 'range');
      const range = parseRangeHeader(rangeHeader, resolved.size);
      if (range !== null) {
        r.code(206)
          .header('content-length', String(range.length))
          .header('content-range', `bytes ${range.start}-${range.end}/${resolved.size}`);
        const stream = createReadStream(resolved.absolute, {
          start: range.start,
          end: range.end,
        });
        stream.on('error', (error: unknown) => {
          requestLog(req)?.warn(
            { session_id, path: relPath, err: error },
            'fs download stream error',
          );
          try {
            stream.destroy();
          } catch {
            // best-effort
          }
        });
        return r.send(stream) as unknown as void;
      }

      r.code(200).header('content-length', String(resolved.size));
      const stream = createReadStream(resolved.absolute);
      stream.on('error', (error: unknown) => {
        requestLog(req)?.warn(
          { session_id, path: relPath, err: error },
          'fs download stream error',
        );
        try {
          stream.destroy();
        } catch {
          // best-effort
        }
      });
      return r.send(stream) as unknown as void;
    },
  );
  app.get(
    downloadRoute.path,
    downloadRoute.options,
    downloadRoute.handler as unknown as Parameters<FsRouteHost['get']>[2],
  );
}

// ---------------------------------------------------------------------------
// Action handlers — thin adapters: parse body, call ISessionFsService, wrap result.
// ---------------------------------------------------------------------------

type Req = { id: string; body: unknown };
type Reply = { send(payload: unknown): unknown };

async function handleList(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsListRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).list(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleRead(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsReadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).read(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleListMany(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsListManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).listMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleStat(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsStatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).stat(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleStatMany(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsStatManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).statMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleMkdir(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsMkdirRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).mkdir(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleSearch(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsSearchRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).search(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleGrep(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsGrepRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).grep(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleGitStatus(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsGitStatusRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).gitStatus(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleDiff(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsDiffRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await resolveFs(core, sessionId).diff(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleOpen(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsOpenRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await resolveFs(core, sessionId).resolvePath(parsed.data.path);
  await launchDetached(openFileCommandFor(resolved.absolute, parsed.data.line));
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

async function handleReveal(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsRevealRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await resolveFs(core, sessionId).resolvePath(parsed.data.path);
  await launchDetached(revealFileCommandFor(resolved.absolute));
  reply.send(okEnvelope({ revealed: true as const }, req.id));
}

async function handleOpenIn(core: Scope, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsOpenInRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body = parsed.data;
  const resolved = await resolveFs(core, sessionId).resolvePath(body.path);
  try {
    await launchDetached(
      openInAppCommandFor(body.app_id, resolved.absolute, {
        line: body.line,
        isDirectory: resolved.isDirectory,
      }),
    );
  } catch (err) {
    requestLog(req)?.warn(
      { session_id: sessionId, app_id: body.app_id, err },
      'fs open-in launch failed',
    );
    reply.send(
      errEnvelope(
        ErrorCode.INTERNAL_ERROR,
        `failed to open in ${body.app_id}: ${err instanceof Error ? err.message : String(err)}`,
        req.id,
      ),
    );
    return;
  }
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

// ---------------------------------------------------------------------------
// Error mapping — domain Error2 codes → protocol wire codes.
// ---------------------------------------------------------------------------

function sendMappedError(reply: Reply, req: { id: string }, err: unknown): void {
  const requestId = req.id;
  const log = requestLog(req);
  if (isError2(err)) {
    switch (err.code) {
      case ErrorCodes.FS_PATH_ESCAPES:
        reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_PATH_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_IS_DIRECTORY:
        reply.send(errEnvelope(ErrorCode.FS_IS_DIRECTORY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.FS_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_IS_BINARY:
        reply.send(errEnvelope(ErrorCode.FS_IS_BINARY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_TOO_LARGE:
        reply.send(errEnvelope(ErrorCode.FS_TOO_LARGE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_TOO_MANY_RESULTS:
        reply.send(errEnvelope(ErrorCode.FS_TOO_MANY_RESULTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_GREP_TIMEOUT:
        reply.send(errEnvelope(ErrorCode.FS_GREP_TIMEOUT, err.message, requestId, err.stack));
        return;
      case ErrorCodes.FS_GIT_UNAVAILABLE:
        reply.send(errEnvelope(ErrorCode.FS_GIT_UNAVAILABLE, err.message, requestId, err.stack));
        return;
      case ErrorCodes.SESSION_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId, err.stack));
        return;
      // hostFs errors that escaped the sessionFs layer keep their `os.fs.*`
      // code; map them onto the closest v1 wire code (ENOTDIR collapses into
      // path-not-found, matching `mapFsError`).
      case ErrorCodes.OS_FS_NOT_FOUND:
      case ErrorCodes.OS_FS_NOT_DIRECTORY:
        reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_IS_DIRECTORY:
        reply.send(errEnvelope(ErrorCode.FS_IS_DIRECTORY, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_ALREADY_EXISTS:
        reply.send(errEnvelope(ErrorCode.FS_ALREADY_EXISTS, err.message, requestId, err.stack));
        return;
      case ErrorCodes.OS_FS_PERMISSION_DENIED:
        reply.send(errEnvelope(ErrorCode.FS_PERMISSION_DENIED, err.message, requestId, err.stack));
        return;
    }
  }
  log?.error({ err }, 'fs request failed');
  reply.send(
    errEnvelope(
      ErrorCode.INTERNAL_ERROR,
      err instanceof Error ? err.message : String(err),
      requestId,
      err instanceof Error ? err.stack : undefined,
    ),
  );
}

function buildValidationEnvelope(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
  requestId: string,
): {
  code: number;
  msg: string;
  data: null;
  request_id: string;
  details: { path: string; message: string }[];
} {
  const details = issues.map((i) => ({
    path: i.path.map((p) => String(p)).join('.'),
    message: i.message,
  }));
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  return {
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId,
    details,
  };
}

function sanitizeFilename(rel: string): string {
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? rel;
  return base.replace(/"/g, '\\"');
}
