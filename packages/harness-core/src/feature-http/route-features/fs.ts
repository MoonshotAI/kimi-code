import type { Request, Response } from 'express';

import { useApp, type SessionRecord } from '@moonshot-ai/agent-core';
import { isAbsolute } from 'pathe';
import { z } from 'zod';

import {
  launchDetached,
  launchPlatformFor,
  openFileCommandFor,
  openInAppCommandFor,
  revealFileCommandFor,
} from '#/features/os/fileLaunch';
import {
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
  fsSuggestRequestSchema,
  sessionWorkspaceId,
  type FsSearchRequest,
  type FsSuggestRequest,
  type WorkspaceFsRoots,
  type WorkspacesFace,
} from '#/features/workspaces/index';

import { useHttpRoute } from '../feature';
import { ErrorCode, param, sendErr, sendOk } from '../route/http';
import {
  handleFsMkdir,
  parseRangeHeader,
  readColonAction,
  sendValidationDetails,
  sendWorkspaceErr,
  workspacesFacade,
  workspacesFs,
} from './workspaces';

const FS_TAIL_PREFIX = 'fs:';
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

const runtimeIdEnvelopeSchema = z.object({ runtime_id: z.string().min(1).optional() }).passthrough();

const workspaceFsSearchBodySchema = fsSearchRequestSchema.extend({
  workspace: z.string().min(1),
  runtime_id: z.string().min(1).optional(),
});

const workspaceFsSuggestBodySchema = fsSuggestRequestSchema.extend({
  workspace: z.string().min(1),
  runtime_id: z.string().min(1).optional(),
});

const rootFsSuggestBodySchema = fsSuggestRequestSchema.extend({
  roots: z.array(z.string().min(1)).min(1).max(32),
  runtime_id: z.string().min(1).optional(),
});

const DOWNLOAD_SUFFIX = ':download';

export function useFsRoutes(prefix: string): void {
  useHttpRoute({
    id: 'sessions.fs.action',
    method: 'POST',
    path: `${prefix}/sessions/:session_id/:tail`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      const tail = param(request, 'tail');
      if (sessionId === undefined || tail === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      if (!tail.startsWith(FS_TAIL_PREFIX)) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${tail}`,
        );
        return;
      }
      const action = tail.slice(FS_TAIL_PREFIX.length);
      if (!(FS_ACTIONS as readonly string[]).includes(action)) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${tail}`,
        );
        return;
      }
      const face = workspacesFacade(request, response);
      if (face === undefined) return;
      const fs = workspacesFs(request, response, face);
      if (fs === undefined) return;
      const envelope = runtimeIdEnvelopeSchema.safeParse(request.body ?? {});
      if (!envelope.success) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'request body must be an object',
        );
        return;
      }
      const { runtime_id: _runtimeId, ...rest } = envelope.data;
      const record = await useApp().space.get(sessionId);
      let roots: WorkspaceFsRoots | undefined;
      if (record === undefined) {
        if (action === 'search') {
          roots = await resolveWorkspaceRef(face, sessionId);
          if (roots === undefined) {
            sendErr(
              request,
              response,
              ErrorCode.WORKSPACE_NOT_FOUND,
              `workspace ${sessionId} does not exist`,
            );
            return;
          }
        } else {
          sendErr(
            request,
            response,
            ErrorCode.SESSION_NOT_FOUND,
            `session ${sessionId} does not exist`,
          );
          return;
        }
      } else {
        const resolution = await rootsForSession(face, record);
        if (resolution.kind !== 'ok') {
          sendSessionWorkspaceErr(request, response, sessionId, resolution);
          return;
        }
        roots = resolution.roots;
      }
      const view = fs.view(roots as WorkspaceFsRoots);
      switch (action) {
        case 'list':
          await runFsAction(request, response, fsListRequestSchema, rest, (req) => view.list(req));
          return;
        case 'read':
          await runFsAction(request, response, fsReadRequestSchema, rest, (req) => view.read(req));
          return;
        case 'list_many':
          await runFsAction(request, response, fsListManyRequestSchema, rest, (req) =>
            view.listMany(req),
          );
          return;
        case 'stat':
          await runFsAction(request, response, fsStatRequestSchema, rest, (req) => view.stat(req));
          return;
        case 'stat_many':
          await runFsAction(request, response, fsStatManyRequestSchema, rest, (req) =>
            view.statMany(req),
          );
          return;
        case 'mkdir':
          await runFsAction(request, response, fsMkdirRequestSchema, rest, (req) => view.mkdir(req));
          return;
        case 'search':
          await runFsAction(request, response, fsSearchRequestSchema, rest, (req) =>
            view.search(req),
          );
          return;
        case 'grep':
          await runFsAction(request, response, fsGrepRequestSchema, rest, (req) => view.grep(req));
          return;
        case 'git_status':
          await runFsAction(request, response, fsGitStatusRequestSchema, rest, (req) =>
            view.gitStatus(req),
          );
          return;
        case 'diff':
          await runFsAction(request, response, fsDiffRequestSchema, rest, (req) => view.diff(req));
          return;
        case 'open':
          await runFsAction(request, response, fsOpenRequestSchema, rest, async (req) => {
            const resolved = await view.resolvePath(req.path);
            await launchDetached(
              fs.host.process,
              openFileCommandFor(
                resolved.absolute,
                req.line,
                process.env,
                launchPlatformFor(fs.host.environment),
              ),
            );
            return { opened: true as const };
          });
          return;
        case 'open-in': {
          const parsed = fsOpenInRequestSchema.safeParse(rest);
          if (!parsed.success) {
            sendZodIssues(request, response, parsed.error.issues);
            return;
          }
          try {
            const resolved = await view.resolvePath(parsed.data.path);
            await launchDetached(
              fs.host.process,
              openInAppCommandFor(
                parsed.data.app_id,
                resolved.absolute,
                { line: parsed.data.line, isDirectory: resolved.isDirectory },
                launchPlatformFor(fs.host.environment),
              ),
            );
          } catch (error) {
            if (sendWorkspaceErr(request, response, error)) return;
            sendErr(
              request,
              response,
              ErrorCode.INTERNAL_ERROR,
              `failed to open in ${parsed.data.app_id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return;
          }
          sendOk(request, response, { opened: true as const });
          return;
        }
        case 'reveal':
          await runFsAction(request, response, fsRevealRequestSchema, rest, async (req) => {
            const resolved = await view.resolvePath(req.path);
            await launchDetached(
              fs.host.process,
              revealFileCommandFor(resolved.absolute, launchPlatformFor(fs.host.environment)),
            );
            return { revealed: true as const };
          });
          return;
      }
    },
  });

  useHttpRoute({
    id: 'workspaces.fs.action',
    method: 'POST',
    path: `${prefix}/workspace/fs:action`,
    handler: async (request, response) => {
      const action = readColonAction(request);
      const face = workspacesFacade(request, response);
      if (face === undefined) return;
      const fs = workspacesFs(request, response, face);
      if (fs === undefined) return;
      if (action === 'search') {
        const parsed = workspaceFsSearchBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          sendZodIssues(request, response, parsed.error.issues);
          return;
        }
        const { workspace, runtime_id: _runtimeId, ...searchRequest } = parsed.data;
        const roots = await resolveWorkspaceRef(face, workspace);
        if (roots === undefined) {
          sendWorkspaceRefNotFound(request, response, workspace);
          return;
        }
        try {
          sendOk(request, response, await fs.view(roots).search(searchRequest as FsSearchRequest));
        } catch (error) {
          if (sendWorkspaceErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      if (action === 'suggest') {
        const parsed = workspaceFsSuggestBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          sendZodIssues(request, response, parsed.error.issues);
          return;
        }
        const { workspace, runtime_id: _runtimeId, ...suggestRequest } = parsed.data;
        const roots = await resolveWorkspaceRef(face, workspace);
        if (roots === undefined) {
          sendWorkspaceRefNotFound(request, response, workspace);
          return;
        }
        try {
          sendOk(
            request,
            response,
            await fs.view(roots).suggest(suggestRequest as FsSuggestRequest),
          );
        } catch (error) {
          if (sendWorkspaceErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      sendErr(
        request,
        response,
        ErrorCode.VALIDATION_FAILED,
        `unsupported action: fs:${action ?? ''}`,
      );
    },
  });

  useHttpRoute({
    id: 'fs.action',
    method: 'POST',
    path: `${prefix}/fs:action`,
    handler: async (request, response) => {
      const action = readColonAction(request);
      const face = workspacesFacade(request, response);
      if (face === undefined) return;
      const fs = workspacesFs(request, response, face);
      if (fs === undefined) return;
      if (action === 'mkdir') {
        await handleFsMkdir(request, response, fs);
        return;
      }
      if (action === 'suggest') {
        const parsed = rootFsSuggestBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
          sendZodIssues(request, response, parsed.error.issues);
          return;
        }
        const { roots, runtime_id: _runtimeId, ...suggestRequest } = parsed.data;
        for (const root of roots) {
          if (!isAbsolute(root)) {
            sendErr(
              request,
              response,
              ErrorCode.VALIDATION_FAILED,
              `root must be an absolute path: ${root}`,
            );
            return;
          }
        }
        for (const root of roots) {
          let stat;
          try {
            stat = await fs.stat(root);
          } catch {
            stat = undefined;
          }
          if (stat === undefined) {
            sendErr(
              request,
              response,
              ErrorCode.FS_PATH_NOT_FOUND,
              `root not found: ${root}`,
            );
            return;
          }
          if (!stat.isDirectory) {
            sendErr(
              request,
              response,
              ErrorCode.FS_PATH_NOT_FOUND,
              `root is not a directory: ${root}`,
            );
            return;
          }
        }
        const view = fs.view({ workDir: roots[0] as string, additionalDirs: roots.slice(1) });
        try {
          sendOk(request, response, await view.suggest(suggestRequest as FsSuggestRequest));
        } catch (error) {
          if (sendWorkspaceErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      sendErr(
        request,
        response,
        ErrorCode.VALIDATION_FAILED,
        `unsupported action: fs:${action ?? ''}`,
      );
    },
  });

  useHttpRoute({
    id: 'sessions.fs.download',
    method: 'GET',
    path: `${prefix}/sessions/:session_id/fs/{*splat}`,
    handler: async (request, response) => {
      const sessionId = param(request, 'session_id');
      if (sessionId === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'session_id is required');
        return;
      }
      const splat = request.params['splat'] as unknown;
      const wildcard = Array.isArray(splat)
        ? splat.join('/')
        : typeof splat === 'string'
          ? splat
          : '';
      if (!wildcard.endsWith(DOWNLOAD_SUFFIX)) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          `unsupported action: ${wildcard}`,
        );
        return;
      }
      const relPath = wildcard.slice(0, -DOWNLOAD_SUFFIX.length);
      if (relPath.length === 0) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'path is empty');
        return;
      }
      const face = workspacesFacade(request, response);
      if (face === undefined) return;
      const fs = workspacesFs(request, response, face);
      if (fs === undefined) return;
      const record = await useApp().space.get(sessionId);
      if (record === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.SESSION_NOT_FOUND,
          `session ${sessionId} does not exist`,
        );
        return;
      }
      const resolution = await rootsForSession(face, record);
      if (resolution.kind !== 'ok') {
        sendSessionWorkspaceErr(request, response, sessionId, resolution);
        return;
      }
      const view = fs.view(resolution.roots);
      let resolved;
      try {
        resolved = await view.resolveDownload(relPath);
      } catch (error) {
        if (sendWorkspaceErr(request, response, error)) return;
        throw error;
      }
      const ifNoneMatch = request.get('if-none-match');
      if (ifNoneMatch !== undefined && ifNoneMatch === resolved.etag) {
        response.status(304).setHeader('etag', resolved.etag).send('');
        return;
      }
      response.setHeader('etag', resolved.etag);
      response.setHeader('last-modified', resolved.modifiedAt.toUTCString());
      response.setHeader(
        'content-disposition',
        `attachment; filename="${sanitizeFilename(resolved.relative)}"`,
      );
      response.type(resolved.mime);
      const range = parseRangeHeader(request.get('range'), resolved.size);
      if (range !== null) {
        const bytes = await fs.read(resolved.absolute, range.length, range.start);
        response
          .status(206)
          .setHeader('content-length', String(range.length))
          .setHeader('content-range', `bytes ${range.start}-${range.end}/${resolved.size}`)
          .send(Buffer.from(bytes));
        return;
      }
      const bytes = await fs.read(resolved.absolute);
      response
        .status(200)
        .setHeader('content-length', String(resolved.size))
        .send(Buffer.from(bytes));
    },
  });
}

async function runFsAction<S extends z.ZodType>(
  request: Request,
  response: Response,
  schema: S,
  body: unknown,
  run: (req: z.infer<S>) => Promise<unknown>,
): Promise<void> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    sendZodIssues(request, response, parsed.error.issues);
    return;
  }
  try {
    sendOk(request, response, await run(parsed.data));
  } catch (error) {
    if (sendWorkspaceErr(request, response, error)) return;
    throw error;
  }
}

function sendZodIssues(
  request: Request,
  response: Response,
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): void {
  sendValidationDetails(
    request,
    response,
    issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  );
}

interface SessionRootsResolution {
  readonly kind: 'ok' | 'unbound' | 'dangling';
  readonly roots: WorkspaceFsRoots;
  readonly workspaceId?: string;
}

async function rootsForSession(
  face: WorkspacesFace,
  record: SessionRecord,
): Promise<SessionRootsResolution> {
  const bound = sessionWorkspaceId(record);
  if (bound !== undefined) {
    const workspace = face.get(bound);
    if (workspace === undefined) {
      return { kind: 'dangling', roots: { workDir: '' }, workspaceId: bound };
    }
    return {
      kind: 'ok',
      roots: { workDir: workspace.root, additionalDirs: await face.additionalDirs(workspace.id) },
    };
  }
  const cwd = record.metadata?.['cwd'];
  if (typeof cwd === 'string' && cwd.length > 0) {
    const workspace = face.findByRoot(cwd);
    if (workspace !== undefined) {
      return {
        kind: 'ok',
        roots: {
          workDir: workspace.root,
          additionalDirs: await face.additionalDirs(workspace.id),
        },
      };
    }
    return { kind: 'ok', roots: { workDir: cwd } };
  }
  return { kind: 'unbound', roots: { workDir: '' } };
}

function sendSessionWorkspaceErr(
  request: Request,
  response: Response,
  sessionId: string,
  resolution: SessionRootsResolution,
): void {
  if (resolution.kind === 'dangling') {
    sendErr(
      request,
      response,
      ErrorCode.WORKSPACE_NOT_FOUND,
      `workspace ${resolution.workspaceId ?? ''} does not exist`,
    );
    return;
  }
  sendErr(
    request,
    response,
    ErrorCode.WORKSPACE_NOT_FOUND,
    `session ${sessionId} has no workspace bound`,
  );
}

async function resolveWorkspaceRef(
  face: WorkspacesFace,
  ref: string,
): Promise<WorkspaceFsRoots | undefined> {
  let workspace = face.get(ref);
  if (workspace === undefined) {
    if (!isAbsolute(ref)) return undefined;
    try {
      workspace = await face.createOrTouch(ref);
    } catch {
      return undefined;
    }
  }
  return {
    workDir: workspace.root,
    additionalDirs: await face.additionalDirs(workspace.id),
  };
}

function sendWorkspaceRefNotFound(request: Request, response: Response, ref: string): void {
  sendErr(
    request,
    response,
    ErrorCode.WORKSPACE_NOT_FOUND,
    `workspace ${ref} does not exist`,
  );
}

function sanitizeFilename(rel: string): string {
  const segs = rel.split('/');
  const base = segs.at(-1) ?? rel;
  return base.replace(/"/g, '\\"');
}
