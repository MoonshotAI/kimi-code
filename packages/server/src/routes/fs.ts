

import { createReadStream } from 'node:fs';

import {
  ErrorCode,
  fsDiffRequestSchema,
  fsGitStatusRequestSchema,
  fsGrepRequestSchema,
  fsListManyRequestSchema,
  fsListRequestSchema,
  fsMkdirRequestSchema,
  fsOpenInRequestSchema,
  fsOpenRequestSchema,
  fsReadRequestSchema,
  fsRevealRequestSchema,
  fsSearchRequestSchema,
  fsStatManyRequestSchema,
  fsStatRequestSchema,
  type FsDiffRequest,
  type FsGitStatusRequest,
  type FsGrepRequest,
  type FsListManyRequest,
  type FsListRequest,
  type FsMkdirRequest,
  type FsOpenInRequest,
  type FsOpenRequest,
  type FsReadRequest,
  type FsRevealRequest,
  type FsSearchRequest,
  type FsStatManyRequest,
  type FsStatRequest,
} from '@moonshot-ai/protocol';
import { SessionNotFoundError, FsAlreadyExistsError, FsIsBinaryError, FsIsDirectoryError, FsPathNotFoundError, FsTooLargeError, FsTooManyResultsError, IFsService, FsGrepTimeoutError, IFsSearchService, FsGitUnavailableError, IFsGitService, FsPathEscapesError, type IInstantiationService } from '@moonshot-ai/agent-core';
import { z } from 'zod';


import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  launchDetached,
  openFileCommandFor,
  openInAppCommandFor,
  revealFileCommandFor,
} from '../lib/fileLaunch';

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
      req: {
        id: string;
        params: unknown;
        headers: Record<string, string | string[] | undefined>;
        raw: { on(event: string, cb: () => void): unknown };
      },
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

export function registerFsRoutes(
  app: FsRouteHost,
  ix: IInstantiationService,
): void {

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
        'Filesystem action dispatcher. Supported actions: list, read, list_many, stat, stat_many, mkdir, search, grep, git_status, diff, open, reveal.',
      tags: ['fs'],
      operationId: 'fsAction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;

      if (!tail.startsWith(FS_TAIL_PREFIX)) {

        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `unsupported action: ${tail}`,
            req.id,
          ),
        );
        return;
      }

      const action = tail.slice(FS_TAIL_PREFIX.length);
      if (!(FS_ACTIONS as readonly string[]).includes(action)) {
        reply.send(
          errEnvelope(
            ErrorCode.VALIDATION_FAILED,
            `unsupported action: ${tail}`,
            req.id,
          ),
        );
        return;
      }
      const fsAction = action as FsAction;

      try {
        switch (fsAction) {
          case 'list':
            await handleList(ix, session_id, req, reply);
            return;
          case 'read':
            await handleRead(ix, session_id, req, reply);
            return;
          case 'list_many':
            await handleListMany(ix, session_id, req, reply);
            return;
          case 'stat':
            await handleStat(ix, session_id, req, reply);
            return;
          case 'stat_many':
            await handleStatMany(ix, session_id, req, reply);
            return;
          case 'mkdir':
            await handleMkdir(ix, session_id, req, reply);
            return;
          case 'search':
            await handleSearch(ix, session_id, req, reply);
            return;
          case 'grep':
            await handleGrep(ix, session_id, req, reply);
            return;
          case 'git_status':
            await handleGitStatus(ix, session_id, req, reply);
            return;
          case 'diff':
            await handleDiff(ix, session_id, req, reply);
            return;
          case 'open':
            await handleOpen(ix, session_id, req, reply);
            return;
          case 'open-in':
            await handleOpenIn(ix, session_id, req, reply);
            return;
          case 'reveal':
            await handleReveal(ix, session_id, req, reply);
            return;
        }
      } catch (err) {
        sendMappedError(reply, req.id, err);
      }
    },
  );
  app.post(
    fsActionRoute.path,
    fsActionRoute.options,
    fsActionRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  const downloadHandler: Parameters<FsRouteHost['get']>[2] = async (
    req,
    reply,
  ) => {
    const { session_id } = req.params as { session_id: string };
    const wildcard = (req.params as Record<string, unknown>)['*'] as string;

    const DOWNLOAD_SUFFIX = ':download';
    if (!wildcard.endsWith(DOWNLOAD_SUFFIX)) {
      return reply.send(
        errEnvelope(
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${wildcard}`,
          req.id,
        ),
      );
    }
    const relPath = wildcard.slice(0, -DOWNLOAD_SUFFIX.length);
    if (relPath.length === 0) {
      return reply.send(
        errEnvelope(
          ErrorCode.VALIDATION_FAILED,
          'path is empty',
          req.id,
        ),
      );
    }

    let resolved: import('@moonshot-ai/agent-core').FsDownloadResolved;
    try {
      resolved = await ix.invokeFunction((a) =>
        a.get(IFsService).resolveDownload(session_id, relPath),
      );
    } catch (err) {
      sendMappedError(reply, req.id, err);
      return reply;
    }

    const ifNoneMatch = pickHeader(req.headers, 'if-none-match');
    if (ifNoneMatch !== undefined && ifNoneMatch === resolved.etag) {
      return reply.code(304).header('etag', resolved.etag).send('');
    }

    reply.header('etag', resolved.etag);
    reply.header(
      'last-modified',
      resolved.modifiedAt.toUTCString(),
    );
    reply.header(
      'content-disposition',
      `attachment; filename="${sanitizeFilename(resolved.relative)}"`,
    );
    reply.type(resolved.mime);

    const rangeHeader = pickHeader(req.headers, 'range');
    const range = parseRangeHeader(rangeHeader, resolved.size);
    if (range !== null) {
      reply
        .code(206)
        .header('content-length', String(range.length))
        .header(
          'content-range',
          `bytes ${range.start}-${range.end}/${resolved.size}`,
        );
      const stream = createReadStream(resolved.absolute, {
        start: range.start,
        end: range.end,
      });

      stream.on('error', () => {

        try {
          stream.destroy();
        } catch {

        }
      });
      return reply.send(stream);
    }

    reply.code(200).header('content-length', String(resolved.size));
    const stream = createReadStream(resolved.absolute);
    stream.on('error', () => {
      try {
        stream.destroy();
      } catch {

      }
    });

    return reply.send(stream);
  };

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
    downloadHandler as unknown as Parameters<typeof defineRoute>[1],
  );
  app.get(
    downloadRoute.path,
    downloadRoute.options,
    downloadRoute.handler as unknown as Parameters<FsRouteHost['get']>[2],
  );
}

async function handleList(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsListRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsListRequest = parsed.data;
  const data = await ix.invokeFunction((a) => a.get(IFsService).list(sessionId, body));
  reply.send(okEnvelope(data, req.id));
}

async function handleRead(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsReadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsReadRequest = parsed.data;
  const data = await ix.invokeFunction((a) => a.get(IFsService).read(sessionId, body));
  reply.send(okEnvelope(data, req.id));
}

async function handleListMany(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsListManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsListManyRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsService).listMany(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleStat(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsStatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsStatRequest = parsed.data;
  const data = await ix.invokeFunction((a) => a.get(IFsService).stat(sessionId, body));
  reply.send(okEnvelope(data, req.id));
}

async function handleStatMany(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsStatManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsStatManyRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsService).statMany(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleMkdir(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsMkdirRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsMkdirRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsService).mkdir(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleSearch(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsSearchRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsSearchRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsSearchService).search(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleGrep(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsGrepRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsGrepRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsSearchService).grep(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleGitStatus(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsGitStatusRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsGitStatusRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsGitService).status(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleDiff(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsDiffRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsDiffRequest = parsed.data;
  const data = await ix.invokeFunction((a) =>
    a.get(IFsGitService).diff(sessionId, body),
  );
  reply.send(okEnvelope(data, req.id));
}

async function handleOpen(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsOpenRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsOpenRequest = parsed.data;
  const resolved = await ix.invokeFunction((a) =>
    a.get(IFsService).resolvePath(sessionId, body.path),
  );
  await launchDetached(openFileCommandFor(resolved.absolute, body.line));
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

async function handleReveal(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsRevealRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsRevealRequest = parsed.data;
  const resolved = await ix.invokeFunction((a) =>
    a.get(IFsService).resolvePath(sessionId, body.path),
  );
  await launchDetached(revealFileCommandFor(resolved.absolute));
  reply.send(okEnvelope({ revealed: true as const }, req.id));
}

async function handleOpenIn(
  ix: IInstantiationService,
  sessionId: string,
  req: { id: string; body: unknown },
  reply: { send(payload: unknown): unknown },
): Promise<void> {
  const parsed = fsOpenInRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body: FsOpenInRequest = parsed.data;
  const resolved = await ix.invokeFunction((a) =>
    a.get(IFsService).resolvePath(sessionId, body.path),
  );
  try {
    await launchDetached(
      openInAppCommandFor(body.app_id, resolved.absolute, {
        line: body.line,
        isDirectory: resolved.isDirectory,
      }),
    );
  } catch (err) {
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

function sendMappedError(
  reply: { send(payload: unknown): unknown },
  requestId: string,
  err: unknown,
): void {
  if (err instanceof FsPathEscapesError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, err.message, requestId));
    return;
  }
  if (err instanceof FsPathNotFoundError) {
    reply.send(errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, err.message, requestId));
    return;
  }
  if (err instanceof FsIsDirectoryError) {
    reply.send(errEnvelope(ErrorCode.FS_IS_DIRECTORY, err.message, requestId));
    return;
  }
  if (err instanceof FsAlreadyExistsError) {
    reply.send(errEnvelope(ErrorCode.FS_ALREADY_EXISTS, err.message, requestId));
    return;
  }
  if (err instanceof FsIsBinaryError) {
    reply.send(errEnvelope(ErrorCode.FS_IS_BINARY, err.message, requestId));
    return;
  }
  if (err instanceof FsTooLargeError) {
    reply.send(errEnvelope(ErrorCode.FS_TOO_LARGE, err.message, requestId));
    return;
  }
  if (err instanceof FsTooManyResultsError) {
    reply.send(errEnvelope(ErrorCode.FS_TOO_MANY_RESULTS, err.message, requestId));
    return;
  }
  if (err instanceof FsGrepTimeoutError) {
    reply.send(errEnvelope(ErrorCode.FS_GREP_TIMEOUT, err.message, requestId));
    return;
  }
  if (err instanceof FsGitUnavailableError) {
    reply.send(errEnvelope(ErrorCode.FS_GIT_UNAVAILABLE, err.message, requestId));
    return;
  }
  if (err instanceof SessionNotFoundError) {
    reply.send(errEnvelope(ErrorCode.SESSION_NOT_FOUND, err.message, requestId));
    return;
  }
  throw err;
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
  const msg = first === undefined
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

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

function parseRangeHeader(
  raw: string | undefined,
  size: number,
): { start: number; end: number; length: number } | null {
  if (raw === undefined) return null;
  if (!raw.startsWith('bytes=')) return null;
  const spec = raw.slice('bytes='.length);
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash < 0) return null;
  const leftRaw = spec.slice(0, dash);
  const rightRaw = spec.slice(dash + 1);
  if (leftRaw === '' && rightRaw === '') return null;
  let start: number;
  let end: number;
  if (leftRaw === '') {

    const suffix = Number.parseInt(rightRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    const a = Number.parseInt(leftRaw, 10);
    if (!Number.isFinite(a) || a < 0) return null;
    start = a;
    if (rightRaw === '') {
      end = size - 1;
    } else {
      const b = Number.parseInt(rightRaw, 10);
      if (!Number.isFinite(b) || b < a) return null;
      end = Math.min(b, size - 1);
    }
  }
  if (start >= size || start > end) return null;
  return { start, end, length: end - start + 1 };
}

function sanitizeFilename(rel: string): string {
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? rel;
  return base.replace(/"/g, '\\"');
}
