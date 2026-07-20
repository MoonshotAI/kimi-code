import * as path from "node:path";
import * as vscode from "vscode";

import { Events, Methods } from "../../shared/bridge";
import type { FileChange, ProjectFile } from "../../shared/types";
import type { BaselineSession } from "../managers/baseline.manager";
import {
  isWorkspacePathContained,
  resolveWorkspacePath,
  type WorkspacePath,
} from "../utils/workspace-path";
import type { Handler } from "./types";

interface GetProjectFilesParams {
  query?: string;
  directory?: string;
}
interface PickMediaParams { maxCount?: number; includeVideo?: boolean }
interface FilePathParams { filePath: string }
interface OptionalFilePathParams { filePath?: string }
interface PathsParams { paths: string[] }
interface CheckFilesExistParams { paths: string[] }

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mov"];
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
};

const getProjectFiles: Handler<GetProjectFilesParams | undefined, ProjectFile[]> = async (params, ctx) => {
  if (!ctx.workDirUri) return [];
  return params?.directory !== undefined
    ? ctx.fileManager.listDirectory(ctx.workDirUri, params.directory)
    : ctx.fileManager.searchFiles(ctx.workDirUri, params?.query);
};

const pickMedia: Handler<PickMediaParams, string[]> = async (params) => {
  const maxCount = params.maxCount ?? 9;
  const includeVideo = params.includeVideo ?? true;
  const filters: Record<string, string[]> = { Images: IMAGE_EXTENSIONS };
  if (includeVideo) {
    filters["Videos"] = VIDEO_EXTENSIONS;
    filters["All Media"] = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
  }
  const uris = await vscode.window.showOpenDialog({ canSelectMany: true, filters, title: "Select Media" });
  if (!uris) return [];

  const results: string[] = [];
  for (const uri of uris.slice(0, maxCount)) {
    try {
      const extension = path.extname(uri.fsPath).toLowerCase().slice(1);
      const isVideo = VIDEO_EXTENSIONS.includes(extension);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > (isVideo ? 20 : 10) * 1024 * 1024) continue;
      const bytes = await vscode.workspace.fs.readFile(uri);
      results.push(`data:${mediaMime(extension)};base64,${Buffer.from(bytes).toString("base64")}`);
    } catch {
      // Skip a file that disappears or cannot be read without failing the whole picker.
    }
  }
  return results;
};

const openFile: Handler<FilePathParams, { ok: boolean }> = async ({ filePath }, ctx) => {
  const resolved = await resolveExistingWorkspaceFile(ctx.requireWorkDirUri(), filePath);
  if (resolved === undefined) return { ok: false };
  await vscode.commands.executeCommand("vscode.open", resolved.uri);
  return { ok: true };
};

const openFileDiff: Handler<FilePathParams, { ok: boolean }> = async ({ filePath }, ctx) => {
  const sessionId = ctx.getSessionId();
  const resolved = await resolveExistingWorkspaceFile(ctx.requireWorkDirUri(), filePath);
  if (!sessionId || resolved === undefined) return { ok: false };

  const baselineUri = vscode.Uri.from({
    scheme: "kimi-baseline",
    path: `/${resolved.relativePath}`,
    query: new URLSearchParams({ sessionId }).toString(),
  });
  await vscode.commands.executeCommand(
    "vscode.diff",
    baselineUri,
    resolved.uri,
    `${path.basename(resolved.relativePath)} (changes from Kimi)`,
  );
  return { ok: true };
};

const trackFiles: Handler<PathsParams, FileChange[]> = async ({ paths }, ctx) => {
  const session = requireBaselineSession(ctx);
  const workDirUri = ctx.requireWorkDirUri();
  for (const filePath of paths) {
    const resolved = await resolveWorkspaceFile(workDirUri, filePath, true);
    if (resolved !== undefined) ctx.fileManager.trackFile(ctx.webviewId, resolved.uri.fsPath);
  }
  const changes = await ctx.baselineManager.getChanges(session);
  ctx.broadcast(Events.FileChangesUpdated, changes, ctx.webviewId);
  return changes;
};

const clearTrackedFiles: Handler<void, { ok: boolean }> = async (_, ctx) => {
  ctx.fileManager.clearTracked(ctx.webviewId);
  ctx.broadcast(Events.FileChangesUpdated, [], ctx.webviewId);
  return { ok: true };
};

const revertFiles: Handler<OptionalFilePathParams, { ok: boolean }> = async (params, ctx) => {
  const session = requireBaselineSession(ctx);
  if (params.filePath) {
    const resolved = await resolveWorkspaceFile(ctx.requireWorkDirUri(), params.filePath, true);
    if (resolved === undefined) return { ok: false };
    await ctx.baselineManager.undo(session, resolved.relativePath);
  } else {
    await ctx.baselineManager.undoAll(session);
    ctx.fileManager.clearTracked(ctx.webviewId);
  }
  await ctx.fileManager.refreshChanges(ctx.webviewId);
  return { ok: true };
};

const keepChanges: Handler<OptionalFilePathParams, { ok: boolean }> = async (params, ctx) => {
  const session = requireBaselineSession(ctx);
  if (params.filePath) {
    const resolved = await resolveWorkspaceFile(ctx.requireWorkDirUri(), params.filePath, true);
    if (resolved === undefined) return { ok: false };
    await ctx.baselineManager.keep(session, resolved.relativePath);
    ctx.fileManager.getTracked(ctx.webviewId).delete(resolved.uri.fsPath);
  } else {
    await ctx.baselineManager.keepAll(session);
    ctx.fileManager.clearTracked(ctx.webviewId);
  }
  await ctx.fileManager.refreshChanges(ctx.webviewId);
  return { ok: true };
};

const checkFileExists: Handler<FilePathParams, boolean> = async ({ filePath }, ctx) => {
  if (!ctx.workDirUri) return false;
  return (await resolveExistingWorkspaceFile(ctx.workDirUri, filePath)) !== undefined;
};

const checkFilesExist: Handler<CheckFilesExistParams, Record<string, boolean>> = async ({ paths }, ctx) => {
  if (!ctx.workDirUri) return {};
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (filePath) => [
        filePath,
        (await resolveExistingWorkspaceFile(ctx.workDirUri!, filePath)) !== undefined,
      ] as const),
    ),
  );
};

const getImageDataUri: Handler<FilePathParams, string | null> = async ({ filePath }, ctx) => {
  if (!ctx.workDirUri) return null;
  const resolved = await resolveExistingWorkspaceFile(ctx.workDirUri, decodeURIComponent(filePath));
  if (resolved === undefined) return null;
  const mime = IMAGE_MIME_TYPES[path.extname(resolved.relativePath).toLowerCase()];
  if (!mime) return null;
  try {
    const bytes = await vscode.workspace.fs.readFile(resolved.uri);
    return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
};

export const fileHandlers: Record<string, Handler<any, any>> = {
  [Methods.GetProjectFiles]: getProjectFiles,
  [Methods.PickMedia]: pickMedia,
  [Methods.OpenFile]: openFile,
  [Methods.OpenFileDiff]: openFileDiff,
  [Methods.TrackFiles]: trackFiles,
  [Methods.ClearTrackedFiles]: clearTrackedFiles,
  [Methods.RevertFiles]: revertFiles,
  [Methods.KeepChanges]: keepChanges,
  [Methods.CheckFileExists]: checkFileExists,
  [Methods.CheckFilesExist]: checkFilesExist,
  [Methods.GetImageDataUri]: getImageDataUri,
};

function requireBaselineSession(ctx: Parameters<Handler>[1]): BaselineSession {
  const session = ctx.fileManager.getSession(ctx.webviewId);
  if (session === null) throw new Error("No active session.");
  return session;
}

async function resolveWorkspaceFile(
  workDirUri: vscode.Uri,
  filePath: string,
  allowMissing = false,
): Promise<WorkspacePath | undefined> {
  const resolved = resolveWorkspacePath(workDirUri, filePath);
  if (resolved === undefined || !(await isWorkspacePathContained(workDirUri, resolved.uri, { allowMissing }))) {
    return undefined;
  }
  return resolved;
}

async function resolveExistingWorkspaceFile(
  workDirUri: vscode.Uri,
  filePath: string,
): Promise<WorkspacePath | undefined> {
  const resolved = await resolveWorkspaceFile(workDirUri, filePath);
  if (resolved === undefined) return undefined;
  try {
    await vscode.workspace.fs.stat(resolved.uri);
    return resolved;
  } catch {
    return undefined;
  }
}

function mediaMime(extension: string): string {
  return ({
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
