/**
 * `/api/v1` session filesystem routes — server-v2 port.
 *
 * Mirrors `packages/server/src/routes/fs.ts` path-for-path and schema-for-schema
 * so existing v1 clients keep working against server-v2. Engine mode: the
 * session lives in the Rust engine, not the v2 lifecycle; the read-class
 * actions are served host-side against the session workdir (stages 2d/3a) —
 * `fs:read` via the engine's fs toolset, `fs:list` / `fs:stat` / `fs:search`
 * via plain node:fs, and `fs:*:download` straight from disk. The remaining v2
 * `ISessionFsService` actions (list_many, stat_many, mkdir, grep, git_status,
 * diff, open, open-in, reveal) were retired with the v2 engine. The wire
 * schema comes from the local `protocol/rest-fs` contract.
 */

import { createReadStream, statSync, type Stats } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative } from 'node:path';

import { z } from 'zod';

import { errEnvelope, okEnvelope } from '../envelope';
import type { RustSessionService } from '../services/rustSession/rustSessionService';
import { parseRangeHeader, pickHeader } from '../lib/httpRange';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  fsListRequestSchema,
  fsReadRequestSchema,
  fsSearchRequestSchema,
  fsStatRequestSchema,
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

const FS_ACTIONS = ['list', 'read', 'stat', 'search'] as const;
type FsAction = (typeof FS_ACTIONS)[number];
const FS_TAIL_PREFIX = 'fs:';

export function registerFsRoutes(
  app: FsRouteHost,
  rustSession?: RustSessionService,
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
        'Filesystem action dispatcher. Supported actions: list, read, stat, search.',
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

      // Rust-engine mode: the session lives in the engine, not the v2
      // lifecycle. Serve the read-class actions host-side against the
      // session workdir (stage 2d/3a): read via the engine toolset, list,
      // stat and search via plain node:fs — no v2 sessionFs service.
      if (rustSession !== undefined) {
        if (fsAction === 'read') {
          await handleRustRead(rustSession, session_id, req, reply);
          return;
        }
        if (fsAction === 'search') {
          const workDir = rustSession.getSession(session_id)?.workDir;
          if (workDir === undefined) {
            reply.send(
              errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
            );
            return;
          }
          await handleRustSearch(rustSession, session_id, workDir, req, reply);
          return;
        }
        if (fsAction === 'list' || fsAction === 'stat') {
          const workDir = rustSession.getSession(session_id)?.workDir;
          if (workDir === undefined) {
            reply.send(
              errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
            );
            return;
          }
          if (fsAction === 'list') {
            await handleRustList(workDir, req, reply);
          } else {
            await handleRustStat(workDir, req, reply);
          }
          return;
        }
      }
      // Unreachable: every remaining action is served by the Rust engine
      // above — the v2 sessionFs dispatch was retired with the v2 engine.
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

      // Rust-engine mode (stage 3a, host-owned): resolve the rel path against
      // the session workdir and stream it with plain node:fs — the v2
      // sessionFs resolveDownload path was retired with the v2 engine.
      const workDir = rustSession?.getSession(session_id)?.workDir;
      if (workDir === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }

      const abs = resolveDownloadPath(workDir, relPath);
      if (abs === null) {
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_ESCAPES_SESSION, `path "${relPath}" rejected`, req.id),
        );
        return;
      }
      const rel = relative(workDir, abs).replaceAll('\\', '/');
      let st: Stats;
      try {
        st = statSync(abs);
      } catch {
        reply.send(
          errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `no such file: ${relPath}`, req.id),
        );
        return;
      }
      if (st.isDirectory()) {
        reply.send(
          errEnvelope(ErrorCode.FS_IS_DIRECTORY, `path is a directory: ${relPath}`, req.id),
        );
        return;
      }

      // Etag mirrors the retired v2 sessionFs `buildEtag` (mtime-size-ino, base36).
      const etag = [
        Math.floor(st.mtimeMs).toString(36),
        st.size.toString(36),
        (st.ino ?? 0).toString(36),
      ].join('-');

      const r = reply as unknown as FsDownloadReply;
      const headers = req.headers;

      const ifNoneMatch = pickHeader(headers, 'if-none-match');
      if (ifNoneMatch !== undefined && ifNoneMatch === etag) {
        r.code(304).header('etag', etag).send('');
        return;
      }

      r.header('etag', etag);
      r.header('last-modified', st.mtime.toUTCString());
      r.header(
        'content-disposition',
        `attachment; filename="${sanitizeFilename(rel)}"`,
      );
      r.type(guessDownloadMime(abs));

      const rangeHeader = pickHeader(headers, 'range');
      const range = parseRangeHeader(rangeHeader, st.size);
      if (range !== null) {
        r.code(206)
          .header('content-length', String(range.length))
          .header('content-range', `bytes ${range.start}-${range.end}/${st.size}`);
        const stream = createReadStream(abs, {
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

      r.code(200).header('content-length', String(st.size));
      const stream = createReadStream(abs);
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
// Action handlers — thin adapters: parse body, dispatch the engine / node:fs,
// wrap the result. (The v2 sessionFs action handlers were retired with the
// v2 engine.)
// ---------------------------------------------------------------------------

type Req = { id: string; body: unknown };
type Reply = { send(payload: unknown): unknown };

/** Rust-engine fs:read (stage 2d): the engine's Read tool serves the file;
 *  strip the `N→` line-number prefixes the model-facing tool emits and
 *  project the remaining facts onto the v1 read shape. */
async function handleRustRead(
  rust: RustSessionService,
  sessionId: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsReadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const result = (await rust.fsAction(sessionId, {
    action: 'read',
    path: parsed.data.path,
  })) as { content?: string; is_error?: boolean } | null;
  if (result === null) {
    reply.send(
      errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, req.id),
    );
    return;
  }
  if (result.is_error) {
    reply.send(
      errEnvelope(
        ErrorCode.FS_PATH_NOT_FOUND,
        `read failed: ${result.content ?? 'unknown error'}`,
        req.id,
      ),
    );
    return;
  }
  const content = stripReadLineNumbers(result.content ?? '');
  const size = Buffer.byteLength(content, 'utf8');
  reply.send(
    okEnvelope(
      {
        path: parsed.data.path,
        content,
        encoding: 'utf8',
        size,
        truncated: false,
        etag: `"${simpleHash(content)}"`,
        mime: 'text/plain',
        is_binary: false,
      },
      req.id,
    ),
  );
}

/** Strip the engine Read tool's `      N→` line-number prefixes. */
function stripReadLineNumbers(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*\d+→/, ''))
    .join('\n')
    .replace(/\n$/, '');
}

/** Rust-engine fs:search (stage 2d): the engine's FsSearch tool lists paths
 *  (directories suffixed with `/`); project them onto the v1 search hits. */
async function handleRustSearch(
  rust: RustSessionService,
  sessionId: string,
  workDir: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsSearchRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const result = (await rust.fsAction(sessionId, {
    action: 'search',
    query: parsed.data.query,
    limit: parsed.data.limit,
  })) as { content?: string; is_error?: boolean } | null;
  if (result === null) {
    reply.send(
      errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${sessionId} does not exist`, req.id),
    );
    return;
  }
  if (result.is_error) {
    reply.send(
      errEnvelope(
        ErrorCode.FS_PATH_NOT_FOUND,
        `search failed: ${result.content ?? 'unknown error'}`,
        req.id,
      ),
    );
    return;
  }
  const lines = (result.content ?? '').split('\n').filter((l) => l.trim().length > 0);
  const items = lines
    .slice(0, parsed.data.limit)
    .map((line) => {
      const isDir = line.endsWith('/');
      const path = isDir ? line.slice(0, -1) : line;
      const name = basename(path) || path;
      return {
        path,
        name,
        kind: isDir ? 'directory' : 'file',
        score: 1,
        match_positions: [],
      };
    });
  const truncated = lines.length > parsed.data.limit;
  reply.send(okEnvelope({ items, truncated }, req.id));
}

/** Cheap stable tag for the read response (not a real content hash). */
function simpleHash(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) - h + (text.codePointAt(i) ?? 0)) | 0;
  }
  return (h >>> 0).toString(16);
}

/** Rust-engine fs:list (stage 3a, host-owned): plain node:fs directory read
 *  against the session workdir — no v2 sessionFs service. */
async function handleRustList(
  workDir: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsListRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const dir = join(workDir, parsed.data.path);
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    reply.send(
      errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `no such directory: ${parsed.data.path}`, req.id),
    );
    return;
  }
  const items: unknown[] = [];
  for (const dirent of dirents) {
    if (!parsed.data.show_hidden && dirent.name.startsWith('.')) continue;
    if (items.length >= parsed.data.limit) break;
    const abs = join(dir, dirent.name);
    const rel = join(parsed.data.path, dirent.name).replaceAll('\\', '/');
    let size: number | undefined;
    let modifiedAt = new Date().toISOString();
    try {
      const st = statSync(abs);
      size = st.size;
      modifiedAt = st.mtime.toISOString();
    } catch {
      // broken symlink or race — emit the entry without stat facts
    }
    items.push({
      path: rel,
      name: dirent.name,
      kind: dirent.isDirectory() ? 'directory' : dirent.isSymbolicLink() ? 'symlink' : 'file',
      ...(size !== undefined ? { size } : {}),
      modified_at: modifiedAt,
    });
  }
  reply.send(okEnvelope({ items, truncated: false }, req.id));
}

/** Rust-engine fs:stat (stage 3a, host-owned). */
async function handleRustStat(
  workDir: string,
  req: Req,
  reply: Reply,
): Promise<void> {
  const parsed = fsStatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const abs = join(workDir, parsed.data.path);
  let st;
  try {
    st = statSync(abs);
  } catch {
    reply.send(
      errEnvelope(ErrorCode.FS_PATH_NOT_FOUND, `no such path: ${parsed.data.path}`, req.id),
    );
    return;
  }
  const name = basename(parsed.data.path) || parsed.data.path;
  reply.send(
    okEnvelope(
      {
        path: parsed.data.path,
        name,
        kind: st.isDirectory() ? 'directory' : 'file',
        size: st.size,
        modified_at: st.mtime.toISOString(),
      },
      req.id,
    ),
  );
}

// ---------------------------------------------------------------------------
// Host download resolution — mirrors the retired v2 sessionFs
// `resolveWithin` / `resolveDownload` semantics with plain node:fs.
// ---------------------------------------------------------------------------

/** Reject empty / absolute / `..`-escaping rel paths (v2 `resolveWithin`).
 *  Returns the resolved absolute path inside `workDir`, or null when the path
 *  is rejected or escapes the workspace. */
function resolveDownloadPath(workDir: string, relPath: string): string | null {
  const segments = relPath.split(/[/\\]+/).filter((s) => s.length > 0);
  if (segments.length === 0 || isAbsolute(relPath) || segments.includes('..')) {
    return null;
  }
  const abs = join(workDir, ...segments);
  const rel = relative(workDir, abs);
  if (rel === '..' || rel.startsWith('..')) return null;
  return abs;
}

/** Extension→MIME for downloads (subset of the retired v2 `guessMime` table). */
const DOWNLOAD_EXT_TO_MIME: Readonly<Record<string, string>> = {
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.js': 'text/javascript',
  '.jsx': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'application/toml',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/rust',
  '.go': 'text/x-go',
};

function guessDownloadMime(path: string): string {
  const mapped = DOWNLOAD_EXT_TO_MIME[extname(path).toLowerCase()];
  return mapped ?? 'application/octet-stream';
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
  const base = segs.at(-1) ?? rel;
  return base.replaceAll(/[\u0000-\u001F\u007F]/g, '').replaceAll('"', '\\"');
}
