/**
 * `/sessions/{sid}/fs:*` REST routes.
 *
 * Supported POST actions:
 *
 *   POST /sessions/{sid}/fs:list        → FsListResponse
 *   POST /sessions/{sid}/fs:read        → FsReadResponse
 *   POST /sessions/{sid}/fs:list_many   → FsListManyResponse
 *   POST /sessions/{sid}/fs:stat        → FsEntry
 *   POST /sessions/{sid}/fs:stat_many   → FsStatManyResponse
 *   POST /sessions/{sid}/fs:search      → FsSearchResponse
 *   POST /sessions/{sid}/fs:grep        → FsGrepResponse
 *   POST /sessions/{sid}/fs:git_status  → FsGitStatusResponse
 *
 * **URL convention**: Fastify can't disambiguate `:resource_id` from a
 * `:action` suffix at the same path prefix. find-my-way's `::` colon
 * escape (see `find-my-way/index.js:184`) collapses both colons into a
 * STATIC literal `:`, so `fs::tail` becomes the static literal `fs:tail`
 * NOT the parametric tail we want. We therefore capture the full final
 * segment as `:tail` and split locally on the literal `fs:` prefix.
 *
 * The parametric `:tail` route is registered AFTER all sibling static
 * routes (`messages`, `prompts`, `tasks`, ...) so find-my-way's
 * static-beats-parametric tiebreak picks the correct handler. POSTs that
 * don't start with `fs:` reach this handler and bounce as 40001 — they
 * would have 404'd otherwise (which is fine; either path tells the client
 * the route is wrong).
 *
 * **Error mapping** (see also `services/fs/fs.ts`):
 *
 *   FsPathEscapesError      → 41304 fs.path_escapes_session
 *   FsPathNotFoundError     → 40409 fs.path_not_found
 *   FsIsDirectoryError      → 40906 fs.is_directory
 *   FsIsBinaryError         → 40907 fs.is_binary
 *   FsTooLargeError         → 41302 fs.too_large
 *   FsTooManyResultsError   → 41303 fs.too_many_results
 *   SessionNotFoundError    → 40401 session.not_found
 *
 * **Anti-corruption**: route resolves `IFsService` via the DI accessor;
 * zero SDK imports.
 */

import { createReadStream } from 'node:fs';

import {
  ErrorCode,
  fsGitStatusRequestSchema,
  fsGrepRequestSchema,
  fsListManyRequestSchema,
  fsListRequestSchema,
  fsReadRequestSchema,
  fsSearchRequestSchema,
  fsStatManyRequestSchema,
  fsStatRequestSchema,
  type FsGitStatusRequest,
  type FsGrepRequest,
  type FsListManyRequest,
  type FsListRequest,
  type FsReadRequest,
  type FsSearchRequest,
  type FsStatManyRequest,
  type FsStatRequest,
} from '@moonshot-ai/protocol';
import { SessionNotFoundError } from '@moonshot-ai/services';
import { z } from 'zod';

import type { IInstantiationService } from '@moonshot-ai/agent-core';

import { errEnvelope, okEnvelope } from '../envelope';
import { defineRoute } from '../middleware/defineRoute';
import {
  FsIsBinaryError,
  FsIsDirectoryError,
  FsPathNotFoundError,
  FsTooLargeError,
  FsTooManyResultsError,
  IFsService,
} from '#/services/fs';
import {
  FsGrepTimeoutError,
  IFsSearchService,
} from '#/services/fs';
import {
  FsGitUnavailableError,
  IFsGitService,
} from '#/services/fs';
import { FsPathEscapesError } from '#/services/fs';

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
    ) => Promise<unknown> | unknown,
  ): unknown;
}

/**
 * Reply surface for `:download`. Fastify supports `.type()`, `.header()`,
 * `.code()`, `.send()` (with a stream argument), and `.raw` (underlying
 * ServerResponse) for backpressure-aware streaming. We narrow to the
 * subset we actually call.
 */
interface FsDownloadReply {
  type(mime: string): FsDownloadReply;
  header(name: string, value: string | number): FsDownloadReply;
  code(status: number): FsDownloadReply;
  send(payload: unknown): unknown;
}

const sessionIdAndTailParamSchema = z.object({
  session_id: z.string().min(1),
  // `tail` captures the whole `fs:<action>` segment. We split locally on
  // the literal `fs:` prefix.
  tail: z.string().min(1),
});

const FS_ACTIONS = [
  'list',
  'read',
  'list_many',
  'stat',
  'stat_many',
  'search',
  'grep',
  'git_status',
] as const;
type FsAction = (typeof FS_ACTIONS)[number];
const FS_TAIL_PREFIX = 'fs:';

export function registerFsRoutes(
  app: FsRouteHost,
  ix: IInstantiationService,
): void {
  // POST /sessions/{sid}/fs:<action>
  //
  // Fastify path: `/sessions/:session_id/:tail`. We capture the FULL
  // final segment (`fs:list`, `fs:read`, ...) and split locally — Fastify's
  // `::` colon-escape collapses both colons into a literal `:` STATIC
  // path, NOT a literal `:` followed by a param, so we isolate the action
  // after Fastify routes the request here.
  //
  // The tail's `fs:` prefix is enforced here; non-`fs:` tails 404 from
  // this route — sibling routes (`messages`, `prompts`, `tasks`, etc.)
  // claim the bare-segment paths.
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
      },
      description:
        'Filesystem action dispatcher. Supported actions: list, read, list_many, stat, stat_many, search, grep, git_status.',
      tags: ['fs'],
      operationId: 'fsAction',
    },
    async (req, reply) => {
      const { session_id, tail } = req.params;

      // Sibling routes use the same prefix; this handler is only valid for
      // `fs:<action>` tails. Forward all others by failing as 40001 — the
      // catch-all 404 would have been more semantic but Fastify can't
      // dispatch BETWEEN handlers on the same path; we own the segment.
      if (!tail.startsWith(FS_TAIL_PREFIX)) {
        // Defer to Fastify's 404 by sending the standard `Route not found`
        // shape — but we're already in the handler, so we synthesize the
        // equivalent envelope. In practice no other route registers the
        // same `:tail` slot so this branch is only hit by a typo.
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
          case 'search':
            await handleSearch(ix, session_id, req, reply);
            return;
          case 'grep':
            await handleGrep(ix, session_id, req, reply);
            return;
          case 'git_status':
            await handleGitStatus(ix, session_id, req, reply);
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

  // ---------------------------------------------------------------------
  // GET /sessions/{sid}/fs/*  — streaming download.
  //
  // **Architectural exception**: REST.md §3.9 line 558 — the ONLY GET in
  // the daemon's REST surface with a verb in the URL (`:download`
  // suffix). HTTP semantics dictate GET for downloads.
  //
  // URL pattern (REST.md §3.9 line 562): `GET /sessions/{sid}/fs/{path}:download`
  // `{path}` retains forward slashes; Fastify's `*` wildcard captures
  // everything after `fs/`. We then peel off the `:download` action
  // suffix and validate the path through `IFsService.resolveDownload`.
  //
  // Success: HTTP 200 + `application/octet-stream` (or extension-based
  // mime) + `Content-Length` + `ETag` + `Content-Disposition` + raw
  // bytes via `fs.createReadStream`. Fastify handles backpressure +
  // client-abort cleanup natively when given a Readable stream.
  //
  // 206 (Range): when client passes `Range: bytes=A-B`, we stream the
  // requested window with `Content-Range`.
  //
  // 304: when `If-None-Match` matches the etag.
  //
  // Error paths return HTTP 200 + `application/json` envelope (the
  // documented one-way escape hatch per REST.md §3.9 line 571).
  // ---------------------------------------------------------------------
  const downloadHandler: Parameters<FsRouteHost['get']>[2] = async (
    req,
    reply,
  ) => {
    const { session_id } = req.params as { session_id: string };
    const wildcard = (req.params as Record<string, unknown>)['*'] as string;

    // Strip the `:download` suffix (the only verb we support on this
    // route). Anything else is a 40001.
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

    // Resolve through IFsService. Surfaced errors go through the
    // central sendMappedError (which writes a JSON envelope per the
    // download exception). Success path leaves the response body free
    // for the stream.
    let resolved: import('#/services/fs').FsDownloadResolved;
    try {
      resolved = await ix.invokeFunction((a) =>
        a.get(IFsService).resolveDownload(session_id, relPath),
      );
    } catch (err) {
      sendMappedError(reply, req.id, err);
      return reply;
    }

    // If-None-Match negotiation (REST.md §3.9 line 567).
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

    // Range negotiation (REST.md §3.9 line 565).
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
      // Fastify's reply.send(stream) handles backpressure + client
      // abort. We additionally attach an explicit error handler so a
      // mid-stream EIO surfaces in daemon logs instead of crashing
      // the worker.
      stream.on('error', () => {
        // Already-started stream can't be replaced with an envelope;
        // best we can do is close cleanly.
        try {
          stream.destroy();
        } catch {
          // ignore
        }
      });
      return reply.send(stream);
    }

    // Full-file path. Set content-length explicitly so HTTP keep-alive
    // can frame the response without chunked encoding (Fastify would
    // pick chunked otherwise for streams).
    reply.code(200).header('content-length', String(resolved.size));
    const stream = createReadStream(resolved.absolute);
    stream.on('error', () => {
      try {
        stream.destroy();
      } catch {
        // ignore
      }
    });
    // CRITICAL: return reply.send(stream). Fastify v5 async handlers
    // that fall off the end (returning undefined) will OVERWRITE the
    // already-piped stream body with the undefined return — content-length
    // collapses to 0. Returning the reply (after calling send) keeps the
    // stream as the response body. Same pattern as Fastify docs §"Streams".
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

// ---------------------------------------------------------------------------
// Per-action handlers — each validates its body shape, dispatches against
// IFsService, and re-throws errors for the central mapper.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation envelope helper (mirrors middleware/validate.ts shape but
// runs inline so each handler can pick its own schema based on the action
// the route dispatched to).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// :download helpers
// ---------------------------------------------------------------------------

/**
 * Read a single header value from the request headers map, normalizing
 * the `string | string[] | undefined` shape to `string | undefined`. If
 * the client sent multiple values we take the first.
 */
function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Parse an HTTP `Range: bytes=A-B` header. Supports the most common
 * formats:
 *   - `bytes=0-65535`   first 64 KB
 *   - `bytes=1024-`     from offset 1024 to EOF
 *   - `bytes=-1024`     last 1024 bytes
 *
 * Returns `null` when there's no valid Range. We do NOT implement the
 * multi-range comma-separated form — REST.md §3.9 line 565 only
 * specifies single-range, and clients overwhelmingly use single ranges.
 */
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
    // Suffix range: last N bytes.
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

/**
 * Sanitize a relative path for use in a `Content-Disposition` filename.
 * We keep only the base name and escape double quotes; clients render
 * this as the suggested save filename.
 */
function sanitizeFilename(rel: string): string {
  const segs = rel.split('/');
  const base = segs[segs.length - 1] ?? rel;
  return base.replace(/"/g, '\\"');
}
