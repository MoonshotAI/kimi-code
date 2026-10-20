import type { Request, Response } from 'express';

import { useInject } from '@moonshot-ai/agent-core/kernel/index';
import { isAbsolute } from 'pathe';

import {
  WorkspaceFsError,
  WorkspaceRef,
  type FsBrowseResponse,
  type WorkspaceEntry,
  type WorkspaceFsFace,
  type WorkspacesFace,
} from '#/features/workspaces/index';

import { useHttpRoute } from '../scope';
import { ErrorCode, param, requestId, sendErr, sendOk } from '../route/http';

const WORKSPACE_ID_RE = /^wd_[a-z0-9._-]+_[0-9a-f]{12}$/;

export function useWorkspaceRoutes(prefix: string): void {
  const face = useInject(WorkspaceRef);

  const workspacesFacade = (request: Request, response: Response): WorkspacesFace | undefined =>
    workspacesFacadeOf(face.value, request, response);

  useHttpRoute({
    id: 'workspaces.list',
    method: 'GET',
    path: `${prefix}/workspaces`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const items = await Promise.all(current.list().map((ws) => toWireWorkspace(current, ws)));
      sendOk(request, response, { items });
    },
  });

  useHttpRoute({
    id: 'workspaces.create',
    method: 'POST',
    path: `${prefix}/workspaces`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const body = readCreateBody(request.body);
      if (body === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'root is required');
        return;
      }
      if (body.name !== undefined && (body.name.length === 0 || body.name.length > 100)) {
        sendValidationDetails(request, response, [
          { path: 'name', message: 'name must be a string between 1 and 100 characters' },
        ]);
        return;
      }
      if (!isAbsolute(body.root)) {
        sendValidationDetails(request, response, [
          { path: 'root', message: 'root must be an absolute path' },
        ]);
        return;
      }
      if (current.fs !== undefined) {
        let stat;
        try {
          stat = await current.fs.stat(body.root);
        } catch {
          stat = undefined;
        }
        if (stat === undefined) {
          sendErr(
            request,
            response,
            ErrorCode.FS_PATH_NOT_FOUND,
            `root ${body.root} does not exist`,
          );
          return;
        }
        if (!stat.isDirectory) {
          sendErr(
            request,
            response,
            ErrorCode.FS_PATH_NOT_FOUND,
            `root ${body.root} is not a directory`,
          );
          return;
        }
      }
      try {
        const workspace = await current.createOrTouch(body.root, body.name);
        sendOk(request, response, await toWireWorkspace(current, workspace));
      } catch (error) {
        if (sendWorkspaceErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'workspaces.trust.get',
    method: 'GET',
    path: `${prefix}/workspaces/:workspace_id/trust`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const workspaceId = readWorkspaceIdParam(request, response);
      if (workspaceId === undefined) return;
      const trusted = current.getTrust(workspaceId);
      if (trusted === undefined) {
        sendWorkspaceNotFound(request, response, workspaceId);
        return;
      }
      sendOk(request, response, { trusted });
    },
  });

  useHttpRoute({
    id: 'workspaces.update',
    method: 'PATCH',
    path: `${prefix}/workspaces/:workspace_id`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const workspaceId = readWorkspaceIdParam(request, response);
      if (workspaceId === undefined) return;
      const name = readNameBody(request.body);
      if (name === undefined) {
        sendErr(
          request,
          response,
          ErrorCode.VALIDATION_FAILED,
          'name must be a string between 1 and 100 characters',
        );
        return;
      }
      const workspace = await current.update(workspaceId, { name });
      if (workspace === undefined) {
        sendWorkspaceNotFound(request, response, workspaceId);
        return;
      }
      sendOk(request, response, await toWireWorkspace(current, workspace));
    },
  });

  useHttpRoute({
    id: 'workspaces.delete',
    method: 'DELETE',
    path: `${prefix}/workspaces/:workspace_id`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const workspaceId = readWorkspaceIdParam(request, response);
      if (workspaceId === undefined) return;
      if (current.get(workspaceId) === undefined) {
        sendWorkspaceNotFound(request, response, workspaceId);
        return;
      }
      await current.delete(workspaceId);
      sendOk(request, response, { deleted: true as const });
    },
  });

  useHttpRoute({
    id: 'workspaces.trust.set',
    method: 'POST',
    path: `${prefix}/workspaces/:workspace_id/trust`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const workspaceId = readWorkspaceIdParam(request, response);
      if (workspaceId === undefined) return;
      const trusted = await current.trust(workspaceId);
      if (trusted === undefined) {
        sendWorkspaceNotFound(request, response, workspaceId);
        return;
      }
      sendOk(request, response, { trusted: true });
    },
  });

  useHttpRoute({
    id: 'workspaces.untrust',
    method: 'POST',
    path: `${prefix}/workspaces/:workspace_id/untrust`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const workspaceId = readWorkspaceIdParam(request, response);
      if (workspaceId === undefined) return;
      const trusted = await current.untrust(workspaceId);
      if (trusted === undefined) {
        sendWorkspaceNotFound(request, response, workspaceId);
        return;
      }
      sendOk(request, response, { trusted: false });
    },
  });

  useHttpRoute({
    id: 'workspaces.addDir',
    method: 'POST',
    path: `${prefix}/workspaces/:workspace_id/add-dir`,
    handler: async (request, response) => {
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const workspaceId = readWorkspaceIdParam(request, response);
      if (workspaceId === undefined) return;
      const body = readAddDirBody(request.body);
      if (body === undefined) {
        sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'path is required');
        return;
      }
      const fs = workspacesFs(request, response, current);
      if (fs === undefined) return;
      if (current.get(workspaceId) === undefined) {
        sendWorkspaceNotFound(request, response, workspaceId);
        return;
      }
      try {
        const result = await current.addDir(workspaceId, body.path, body.persist);
        if (result === undefined) {
          sendWorkspaceNotFound(request, response, workspaceId);
          return;
        }
        sendOk(request, response, {
          project_root: result.projectRoot,
          config_path: result.configPath,
          additional_dirs: [...result.additionalDirs],
          persisted: result.persisted,
        });
      } catch (error) {
        if (sendWorkspaceErr(request, response, error)) return;
        throw error;
      }
    },
  });

  useHttpRoute({
    id: 'workspaces.fs.action.get',
    method: 'GET',
    path: `${prefix}/fs:action`,
    handler: async (request, response) => {
      const action = readColonAction(request);
      const current = workspacesFacade(request, response);
      if (current === undefined) return;
      const fs = workspacesFs(request, response, current);
      if (fs === undefined) return;
      if (action === 'browse') {
        await handleFsBrowse(request, response, fs);
        return;
      }
      if (action === 'home') {
        try {
          sendOk(request, response, await fs.home());
        } catch (error) {
          if (sendWorkspaceErr(request, response, error)) return;
          throw error;
        }
        return;
      }
      if (action === 'content') {
        await handleFsContent(request, response, fs);
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
}

export function workspacesFacadeOf(
  face: WorkspacesFace | undefined,
  request: Request,
  response: Response,
): WorkspacesFace | undefined {
  if (face === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.WORKSPACES_UNAVAILABLE,
      'workspaces registry is unavailable (workspaces feature is not installed)',
    );
    return undefined;
  }
  return face;
}

export function workspacesFs(
  request: Request,
  response: Response,
  face: WorkspacesFace,
): WorkspaceFsFace | undefined {
  if (face.fs === undefined) {
    sendErr(
      request,
      response,
      ErrorCode.WORKSPACE_FS_UNAVAILABLE,
      'workspace fs is unavailable (workspaces feature was mounted without an os host)',
    );
    return undefined;
  }
  return face.fs;
}

export function sendWorkspaceErr(request: Request, response: Response, error: unknown): boolean {
  if (!(error instanceof WorkspaceFsError)) return false;
  switch (error.code) {
    case 'fs.not_absolute':
      sendErr(request, response, ErrorCode.VALIDATION_FAILED, error.message);
      return true;
    case 'fs.path_not_found':
      sendErr(request, response, ErrorCode.FS_PATH_NOT_FOUND, error.message);
      return true;
    case 'fs.path_escapes':
      sendErr(request, response, ErrorCode.FS_PATH_ESCAPES_SESSION, error.message);
      return true;
    case 'fs.is_directory':
      sendErr(request, response, ErrorCode.FS_IS_DIRECTORY, error.message);
      return true;
    case 'fs.is_binary':
      sendErr(request, response, ErrorCode.FS_IS_BINARY, error.message);
      return true;
    case 'fs.too_large':
      sendErr(request, response, ErrorCode.FS_TOO_LARGE, error.message);
      return true;
    case 'fs.too_many_results':
      sendErr(request, response, ErrorCode.FS_TOO_MANY_RESULTS, error.message);
      return true;
    case 'fs.already_exists':
      sendErr(request, response, ErrorCode.FS_ALREADY_EXISTS, error.message);
      return true;
    case 'fs.permission_denied':
      sendErr(request, response, ErrorCode.FS_PERMISSION_DENIED, error.message);
      return true;
    case 'fs.grep_timeout':
      sendErr(request, response, ErrorCode.FS_GREP_TIMEOUT, error.message);
      return true;
    case 'fs.git_unavailable':
      sendErr(request, response, ErrorCode.FS_GIT_UNAVAILABLE, error.message);
      return true;
    case 'fs.config_invalid':
      sendErr(request, response, ErrorCode.INTERNAL_ERROR, error.message);
      return true;
  }
}

export function sendValidationDetails(
  request: Request,
  response: Response,
  details: readonly { path: string; message: string }[],
): void {
  const first = details[0];
  const msg =
    first === undefined
      ? 'validation failed'
      : first.path === ''
        ? first.message
        : `${first.path}: ${first.message}`;
  response.status(200).json({
    code: ErrorCode.VALIDATION_FAILED,
    msg,
    data: null,
    request_id: requestId(request),
    details,
  });
}

export async function handleFsMkdir(
  request: Request,
  response: Response,
  fs: WorkspaceFsFace,
): Promise<void> {
  const path = readPathBody(request.body);
  if (path === undefined) {
    sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'path is required');
    return;
  }
  if (!isAbsolute(path)) {
    sendErr(
      request,
      response,
      ErrorCode.VALIDATION_FAILED,
      `path must be absolute: ${path}`,
    );
    return;
  }
  try {
    await fs.mkdir(path);
  } catch (error) {
    if (error instanceof WorkspaceFsError) {
      if (error.code === 'fs.already_exists') {
        sendErr(
          request,
          response,
          ErrorCode.FS_ALREADY_EXISTS,
          `path already exists: ${path}`,
        );
        return;
      }
      if (error.code === 'fs.path_not_found') {
        sendErr(
          request,
          response,
          ErrorCode.FS_PATH_NOT_FOUND,
          `parent path not found: ${path}`,
        );
        return;
      }
      if (error.code === 'fs.permission_denied') {
        sendErr(
          request,
          response,
          ErrorCode.FS_PERMISSION_DENIED,
          `permission denied: ${path}`,
        );
        return;
      }
    }
    if (sendWorkspaceErr(request, response, error)) return;
    throw error;
  }
  sendOk(request, response, { path });
}

async function handleFsBrowse(
  request: Request,
  response: Response,
  fs: WorkspaceFsFace,
): Promise<void> {
  const raw = request.query['path'];
  const path = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  try {
    const data: FsBrowseResponse = await fs.browse(path);
    sendOk(request, response, data);
  } catch (error) {
    if (sendWorkspaceErr(request, response, error)) return;
    throw error;
  }
}

async function handleFsContent(
  request: Request,
  response: Response,
  fs: WorkspaceFsFace,
): Promise<void> {
  const raw = request.query['path'];
  const path = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  if (path === undefined) {
    sendErr(request, response, ErrorCode.VALIDATION_FAILED, 'path is required');
    return;
  }
  if (!isAbsolute(path)) {
    sendErr(
      request,
      response,
      ErrorCode.VALIDATION_FAILED,
      `path must be absolute: ${path}`,
    );
    return;
  }
  let probe;
  try {
    probe = await fs.probe(path);
  } catch (error) {
    if (sendWorkspaceErr(request, response, error)) return;
    throw error;
  }
  if (probe.isDirectory) {
    sendErr(
      request,
      response,
      ErrorCode.FS_IS_DIRECTORY,
      `path is a directory: ${path}`,
    );
    return;
  }
  if (!probe.isFile) {
    sendErr(
      request,
      response,
      ErrorCode.VALIDATION_FAILED,
      `path is not a regular file: ${path}`,
    );
    return;
  }
  const ifNoneMatch = request.get('if-none-match');
  if (ifNoneMatch !== undefined && ifNoneMatch === probe.etag) {
    response.status(304).setHeader('etag', probe.etag).send('');
    return;
  }
  response.setHeader('etag', probe.etag);
  response.setHeader('last-modified', new Date(probe.mtimeMs).toUTCString());
  response.type(probe.mime);
  const range = parseRangeHeader(request.get('range'), probe.size);
  if (range !== null) {
    const bytes = await fs.read(probe.absolute, range.length, range.start);
    response
      .status(206)
      .setHeader('content-length', String(range.length))
      .setHeader('content-range', `bytes ${range.start}-${range.end}/${probe.size}`)
      .send(Buffer.from(bytes));
    return;
  }
  const bytes = await fs.read(probe.absolute);
  response.status(200).setHeader('content-length', String(probe.size)).send(Buffer.from(bytes));
}

export function parseRangeHeader(
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

export function readColonAction(request: Request): string | undefined {
  const raw = param(request, 'action');
  if (raw === undefined || !raw.startsWith(':')) return undefined;
  const action = raw.slice(1);
  return action.length === 0 ? undefined : action;
}

function readWorkspaceIdParam(request: Request, response: Response): string | undefined {
  const workspaceId = param(request, 'workspace_id');
  if (workspaceId === undefined || !WORKSPACE_ID_RE.test(workspaceId)) {
    sendValidationDetails(request, response, [
      { path: 'workspace_id', message: 'workspace_id must be a wd_<slug>_<hash12> string' },
    ]);
    return undefined;
  }
  return workspaceId;
}

function sendWorkspaceNotFound(request: Request, response: Response, workspaceId: string): void {
  sendErr(
    request,
    response,
    ErrorCode.WORKSPACE_NOT_FOUND,
    `workspace ${workspaceId} does not exist`,
  );
}

async function toWireWorkspace(
  face: WorkspacesFace,
  workspace: WorkspaceEntry,
): Promise<Record<string, unknown>> {
  return {
    id: workspace.id,
    root: workspace.root,
    name: workspace.name,
    created_at: new Date(workspace.createdAt).toISOString(),
    last_opened_at: new Date(workspace.lastOpenedAt).toISOString(),
    session_count: await face.sessionCount(workspace.id),
  };
}

function readCreateBody(body: unknown): { root: string; name?: string } | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const root = record['root'];
  if (typeof root !== 'string' || root.length === 0) return undefined;
  const name = record['name'];
  return { root, name: typeof name === 'string' ? name : undefined };
}

function readNameBody(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const name = (body as { [key: string]: unknown })['name'];
  if (typeof name !== 'string' || name.length === 0 || name.length > 100) return undefined;
  return name;
}

function readAddDirBody(body: unknown): { path: string; persist?: boolean } | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const record = body as { [key: string]: unknown };
  const path = record['path'];
  if (typeof path !== 'string' || path.length === 0) return undefined;
  const persist = record['persist'];
  return { path, persist: typeof persist === 'boolean' ? persist : undefined };
}

function readPathBody(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const path = (body as { [key: string]: unknown })['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
