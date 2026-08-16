/**
 * `/api/v1` session filesystem routes — server-v2 port.
 *
 * Mirrors `packages/server/src/routes/fs.ts` path-for-path and schema-for-schema
 * so existing v1 clients keep working against server-v2. Backed by the v2
 * Workspace-scoped `IWorkspaceFsService` (`agent-core-v2/src/workspace/workspaceFs`):
 * the route resolves the session from the URL, then dispatches `fs:<action>`
 * to the matching `IWorkspaceFsService` method — the session's accessor
 * resolves it from its parent Workspace scope (the handler), which is the
 * "session → handler → workspace fs" chain (chdir is gone, so the handler
 * root is the one fixed fs root). The wire schema comes from the engine's own
 * `workspaceFs` domain contract (`agent-core-v2`).
 *
 * Draft-session fallback: a client composing the first prompt of a new
 * session (e.g. kimi-web's new-session draft) has no session id yet, so it
 * passes the workspace reference — registered workspace id or absolute root —
 * in the `{session_id}` slot. Only `fs:search` serves those (the `@` file
 * mention must work before the session exists): the route resolves the
 * workspace's handler directly and uses the same Workspace-scope fs service a
 * real session would resolve to. URL and wire schema are unchanged.
 *
 * First-class workspace search: `POST /workspace/fs:search` carries the same
 * workspace reference in the body (`workspace`), so a session-less client
 * searches without borrowing the `{session_id}` slot. kimi-web's `@` mention
 * uses this route; the session-route fallback above predates it and stays for
 * wire compatibility.
 */

import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';

import {
  ErrorCodes,
  IRuntimeResolver,
  ISessionContext,
  ISessionWorkspaceContext,
  ITelemetryService,
  IWorkspaceFsService,
  IWorkspaceInstanceManager,
  IWorkspaceService,
  getLiveSessionById,
  resumeSessionById,
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
  fsSearchResponseSchema,
  fsStatManyRequestSchema,
  fsStatRequestSchema,
} from '@moonshot-ai/agent-core-v2/workspace/workspaceFs/fs';
import { GitService } from '@moonshot-ai/agent-core-v2/app/git/gitService';
import type { IHostFileSystem } from '@moonshot-ai/agent-core-v2/os/interface/hostFileSystem';
import type { RuntimeCapability, RuntimeLease } from '@moonshot-ai/agent-core-v2/runtime/runtime';
import { WorkspaceFsService } from '@moonshot-ai/agent-core-v2/workspace/workspaceFs/fsService';
import { WorkspaceGitService } from '@moonshot-ai/agent-core-v2/workspace/workspaceGit/workspaceGitService';
import type { IWorkspaceContext } from '@moonshot-ai/agent-core-v2/workspace/workspaceContext/workspaceContext';
import type { IWorkspaceDirs } from '@moonshot-ai/agent-core-v2/workspace/workspaceDirs/workspaceDirs';
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
      req: { id: string; params: unknown; query: unknown; headers: Record<string, unknown> },
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

const fsDownloadQuerySchema = z.object({
  runtime_id: z.string().min(1).optional(),
});

/**
 * Body for `POST /workspace/fs:search`: the engine's fs-search request plus
 * the workspace reference (registered workspace id or absolute root) the
 * session route would otherwise carry in its `{session_id}` slot.
 */
const workspaceFsSearchBodySchema = fsSearchRequestSchema.extend({
  workspace: z.string().min(1),
  runtime_id: z.string().min(1).optional(),
});

const detailsSchema = z.array(z.object({ path: z.string(), message: z.string() }));

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

interface RuntimeFsScope {
  readonly fs: IWorkspaceFsService;
  readonly hostFs: IHostFileSystem;
  readonly lease: RuntimeLease;
}

function createRuntimeFs(
  core: Scope,
  workspaceId: string,
  roots: { readonly workDir: string; readonly additionalDirs?: readonly string[] },
  runtimeId: string,
  required: readonly RuntimeCapability[],
): RuntimeFsScope {
  const lease = core.accessor.get(IRuntimeResolver).acquire(
    { workspaceId, runtimeId },
    required,
  );
  try {
    const mapped = lease.runtime.workspace.mapRoots(roots);
    const workspace = {
      _serviceBrand: undefined,
      workspaceId,
      cwd: mapped.workDir,
      source: 'local',
      meta: {
        id: workspaceId,
        root: mapped.workDir,
        name: workspaceId,
        createdAt: 0,
        lastOpenedAt: 0,
      },
      persistenceScope: `sessions/${workspaceId}`,
    } satisfies IWorkspaceContext;
    const dirs = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      additionalDirs: mapped.additionalDirs ?? [],
      onDidChange: () => ({ dispose: () => {} }),
      addDir: async () => { throw new Error('runtime fs directories are immutable'); },
      mergeAdditionalDirs: async () => { throw new Error('runtime fs directories are immutable'); },
      sessionInfo: () => ({ workDir: mapped.workDir, additionalDirs: mapped.additionalDirs ?? [] }),
    } as unknown as IWorkspaceDirs;
    const resolver: IRuntimeResolver = {
      _serviceBrand: undefined,
      inspect: () => lease.runtime,
      acquire: (_binding, capabilities = []) => {
        const missing = capabilities.filter((capability) => !lease.runtime.capabilities.has(capability));
        if (missing.length > 0) throw new Error(`runtime ${runtimeId} missing capabilities: ${missing.join(', ')}`);
        return {
          runtime: lease.runtime,
          track: (resource) => lease.track(resource),
          dispose: () => {},
        };
      },
    };
    const instances = {
      findByRoot: (root: string) => root === mapped.workDir ? { id: workspaceId } : undefined,
    } as unknown as IWorkspaceInstanceManager;
    const git = new WorkspaceGitService(
      workspace,
      {
        current: new GitService(resolver, instances, lease.runtime.fs!),
        onDidChange: () => ({ dispose: () => {} }),
      },
    );
    return {
      fs: new WorkspaceFsService(
        workspace,
        dirs,
        lease.runtime.fs!,
        resolver,
        core.accessor.get(ITelemetryService),
        git,
        runtimeId,
      ),
      hostFs: lease.runtime.fs!,
      lease,
    };
  } catch (error) {
    lease.dispose();
    throw error;
  }
}

function acquireSessionFs(
  core: Scope,
  sessionId: string,
  runtimeId: string,
  required: readonly RuntimeCapability[],
): RuntimeFsScope {
  const session = getLiveSessionById(core.accessor, sessionId);
  if (session === undefined) throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  const context = session.accessor.get(ISessionContext);
  const workspace = session.accessor.get(ISessionWorkspaceContext);
  return createRuntimeFs(core, context.workspaceId, workspace, runtimeId, required);
}

/**
 * Workspace fallback for `fs:search` (see the file header): resolve a
 * workspace reference — registered id, or an absolute root registered on the
 * spot — to its handler's `IWorkspaceFsService`. `undefined` when the ref is
 * neither a known workspace nor an existing absolute directory.
 */
async function resolveWorkspaceFs(
  core: Scope,
  ref: string,
  runtimeId: string,
  required: readonly RuntimeCapability[],
): Promise<RuntimeFsScope | undefined> {
  const workspaces = core.accessor.get(IWorkspaceService);
  let ws = await workspaces.get(ref);
  if (ws === undefined) {
    if (!isAbsolute(ref)) return undefined;
    try {
      ws = await workspaces.createOrTouch(ref);
    } catch {
      return undefined;
    }
  }
  await core.accessor
    .get(IWorkspaceInstanceManager)
    .getOrCreate({ workspaceId: ws.id, root: ws.root });
  return createRuntimeFs(core, ws.id, { workDir: ws.root }, runtimeId, required);
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
      const session = await resumeSessionById(core.accessor, session_id);
      let runtimeFs: RuntimeFsScope | undefined;
      try {
        const result = z.object({ runtime_id: z.string().min(1).optional() }).passthrough().safeParse(req.body ?? {});
        if (!result.success) {
          reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, 'request body must be an object', req.id));
          return;
        }
        const { runtime_id, ...request } = result.data;
        const runtimeId = runtime_id ?? 'local';
        req.body = request;
        const required: RuntimeCapability[] = ['fs'];
        if (fsAction === 'search' || fsAction === 'grep' || fsAction === 'git_status' || fsAction === 'diff') {
          required.push('process');
        }
        // Draft-session fallback (file header): no session yet, but the client
        // addressed a workspace — `fs:search` resolves it directly.
        runtimeFs = session === undefined && fsAction === 'search'
          ? await resolveWorkspaceFs(core, session_id, runtimeId, required)
          : session === undefined
            ? undefined
            : acquireSessionFs(core, session_id, runtimeId, required);
        if (runtimeFs === undefined) {
          reply.send(
            errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
          );
          return;
        }
        if ((fsAction === 'open' || fsAction === 'open-in' || fsAction === 'reveal') && runtimeFs.lease.runtime.identity.runtimeId !== 'local') {
          throw new Error(`filesystem action ${fsAction} is unavailable on runtime ${runtimeId}`);
        }
        switch (fsAction) {
          case 'list':
            await handleList(runtimeFs.fs, req, reply);
            return;
          case 'read':
            await handleRead(runtimeFs.fs, req, reply);
            return;
          case 'list_many':
            await handleListMany(runtimeFs.fs, req, reply);
            return;
          case 'stat':
            await handleStat(runtimeFs.fs, req, reply);
            return;
          case 'stat_many':
            await handleStatMany(runtimeFs.fs, req, reply);
            return;
          case 'mkdir':
            await handleMkdir(runtimeFs.fs, req, reply);
            return;
          case 'search':
            await handleSearch(runtimeFs.fs, req, reply);
            return;
          case 'grep':
            await handleGrep(runtimeFs.fs, req, reply);
            return;
          case 'git_status':
            await handleGitStatus(runtimeFs.fs, req, reply);
            return;
          case 'diff':
            await handleDiff(runtimeFs.fs, req, reply);
            return;
          case 'open':
            await handleOpen(runtimeFs.fs, req, reply);
            return;
          case 'open-in':
            await handleOpenIn(runtimeFs.fs, session_id, req, reply);
            return;
          case 'reveal':
            await handleReveal(runtimeFs.fs, req, reply);
            return;
        }
      } catch (err) {
        sendMappedError(reply, req, err);
      } finally {
        runtimeFs?.lease.dispose();
      }
    },
  );
  app.post(
    fsActionRoute.path,
    fsActionRoute.options,
    fsActionRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  // Session-less workspace file search (file header): the `@` file mention of
  // a not-yet-created session addresses the workspace directly instead of
  // borrowing the session route's `{session_id}` slot. Declared with a double
  // colon so find-my-way serves it on the wire as `/workspace/fs:search`
  // (same convention as `/fs::browse` in `workspaceFs.ts`).
  const workspaceSearchRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspace/fs::search',
      body: workspaceFsSearchBodySchema,
      success: { data: fsSearchResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: { detailsSchema },
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.FS_TOO_MANY_RESULTS]: {},
      },
      description:
        'Search files in a workspace without a session. `workspace` accepts a registered workspace id or an absolute root (registered on the spot).',
      tags: ['fs'],
      operationId: 'workspaceFsSearch',
    },
    async (req, reply) => {
      const { workspace, runtime_id, ...searchRequest } = req.body;
      let runtimeFs: RuntimeFsScope | undefined;
      try {
        runtimeFs = await resolveWorkspaceFs(core, workspace, runtime_id ?? 'local', ['fs', 'process']);
        if (runtimeFs === undefined) {
          reply.send(
            errEnvelope(
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${workspace} does not exist`,
              req.id,
            ),
          );
          return;
        }
        const data = await runtimeFs.fs.search(searchRequest);
        reply.send(okEnvelope(data, req.id));
      } catch (err) {
        sendMappedError(reply, req, err);
      } finally {
        runtimeFs?.lease.dispose();
      }
    },
  );
  app.post(
    workspaceSearchRoute.path,
    workspaceSearchRoute.options,
    workspaceSearchRoute.handler as unknown as Parameters<FsRouteHost['post']>[2],
  );

  const downloadRoute = defineRoute(
    {
      method: 'GET',
      path: '/sessions/{session_id}/fs/*',
      querystring: fsDownloadQuerySchema,
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
      const session = await resumeSessionById(core.accessor, session_id);
      if (session === undefined) {
        reply.send(
          errEnvelope(ErrorCode.SESSION_NOT_FOUND, `session ${session_id} does not exist`, req.id),
        );
        return;
      }

      let resolved: Awaited<ReturnType<IWorkspaceFsService['resolveDownload']>>;
      let runtimeFs: RuntimeFsScope | undefined;
      try {
        runtimeFs = acquireSessionFs(core, session_id, req.query.runtime_id ?? 'local', ['fs']);
        resolved = await runtimeFs.fs.resolveDownload(relPath);
      } catch (err) {
        runtimeFs?.lease.dispose();
        sendMappedError(reply, req, err);
        return;
      }

      const r = reply as unknown as FsDownloadReply;
      const headers = req.headers;

      const ifNoneMatch = pickHeader(headers, 'if-none-match');
      if (ifNoneMatch !== undefined && ifNoneMatch === resolved.etag) {
        runtimeFs.lease.dispose();
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
        const stream = createRuntimeReadStream(runtimeFs, resolved.absolute, range.start, range.length);
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
      const stream = createRuntimeReadStream(runtimeFs, resolved.absolute, 0, resolved.size);
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

function createRuntimeReadStream(
  runtimeFs: RuntimeFsScope,
  path: string,
  start: number,
  length: number,
): Readable {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let offset = start;
    let remaining = length;
    while (remaining > 0) {
      const chunk = await runtimeFs.hostFs.readBytes(path, Math.min(64 * 1024, remaining), offset);
      if (chunk.byteLength === 0) break;
      offset += chunk.byteLength;
      remaining -= chunk.byteLength;
      yield chunk;
    }
  }
  const stream = Readable.from(chunks());
  const tracked = runtimeFs.lease.track({ dispose: () => { stream.destroy(); } });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    tracked.dispose();
    runtimeFs.lease.dispose();
  };
  stream.once('end', release);
  stream.once('close', release);
  return stream;
}

// ---------------------------------------------------------------------------
// Action handlers — thin adapters: parse body, call IWorkspaceFsService, wrap result.
// ---------------------------------------------------------------------------

type Req = { id: string; body: unknown };
type Reply = { send(payload: unknown): unknown };

async function handleList(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsListRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.list(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleRead(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsReadRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.read(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleListMany(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsListManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.listMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleStat(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsStatRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.stat(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleStatMany(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsStatManyRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.statMany(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleMkdir(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsMkdirRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.mkdir(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleSearch(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsSearchRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.search(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleGrep(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsGrepRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.grep(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleGitStatus(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsGitStatusRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.gitStatus(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleDiff(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsDiffRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const data = await fs.diff(parsed.data);
  reply.send(okEnvelope(data, req.id));
}

async function handleOpen(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsOpenRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await fs.resolvePath(parsed.data.path);
  await launchDetached(openFileCommandFor(resolved.absolute, parsed.data.line));
  reply.send(okEnvelope({ opened: true as const }, req.id));
}

async function handleReveal(fs: IWorkspaceFsService, req: Req, reply: Reply): Promise<void> {
  const parsed = fsRevealRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const resolved = await fs.resolvePath(parsed.data.path);
  await launchDetached(revealFileCommandFor(resolved.absolute));
  reply.send(okEnvelope({ revealed: true as const }, req.id));
}

async function handleOpenIn(fs: IWorkspaceFsService, sessionId: string, req: Req, reply: Reply): Promise<void> {
  const parsed = fsOpenInRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    reply.send(buildValidationEnvelope(parsed.error.issues, req.id));
    return;
  }
  const body = parsed.data;
  const resolved = await fs.resolvePath(body.path);
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
      // hostFs errors that escaped the workspaceFs layer keep their `os.fs.*`
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
