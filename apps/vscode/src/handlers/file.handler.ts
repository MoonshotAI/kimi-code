import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "fs";
import { Methods, Events } from "../../shared/bridge";
import { GitManager } from "../managers";
import type { ProjectFile, EditorContext, FileChange } from "../../shared/types";
import type { Handler } from "./types";

interface GetProjectFilesParams {
  query?: string;
  directory?: string;
}

interface InsertTextParams {
  text: string;
}

interface PickMediaParams {
  maxCount?: number;
  includeVideo?: boolean;
}

interface FilePathParams {
  filePath: string;
}

interface OptionalFilePathParams {
  filePath?: string;
}

interface TrackFilesParams {
  paths: string[];
}

interface CheckFileExistsParams {
  filePath: string;
}

interface CheckFilesExistParams {
  paths: string[];
}

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mov"];

function toAbsolute(workDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(workDir, filePath);
}

function isInsideWorkDir(workDir: string, absolutePath: string): boolean {
  const rel = path.relative(workDir, absolutePath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

function getMimeType(ext: string): string {
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  };
  return mimeTypes[ext] || "application/octet-stream";
}

const getProjectFiles: Handler<GetProjectFilesParams, ProjectFile[]> = async (params, ctx) => {
  if (!ctx.workDir) {
    return [];
  }
  return params.directory !== undefined ? ctx.fileManager.listDirectory(ctx.workDir, params.directory) : ctx.fileManager.searchFiles(params.query);
};

const getEditorContext: Handler<void, EditorContext | null> = async () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return null;
  }

  const doc = editor.document;
  const sel = editor.selection;

  return {
    content: doc.getText(),
    language: doc.languageId,
    fileName: doc.fileName,
    selection: sel.isEmpty
      ? undefined
      : {
          text: doc.getText(sel),
          startLine: sel.start.line + 1,
          endLine: sel.end.line + 1,
        },
  };
};

const insertText: Handler<InsertTextParams, void> = async (params) => {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    await editor.edit((b) => b.insert(editor.selection.active, params.text));
  }
};

const pickMedia: Handler<PickMediaParams, string[]> = async (params) => {
  const maxCount = params.maxCount ?? 9;
  const includeVideo = params.includeVideo ?? true;

  const filters: Record<string, string[]> = {
    Images: IMAGE_EXTENSIONS,
  };
  if (includeVideo) {
    filters["Videos"] = VIDEO_EXTENSIONS;
    filters["All Media"] = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS];
  }

  const uris = await vscode.window.showOpenDialog({
    canSelectMany: true,
    filters,
    title: "Select Media",
  });

  if (!uris) {
    return [];
  }

  const results: string[] = [];
  const maxImageSize = 10 * 1024 * 1024;
  const maxVideoSize = 20 * 1024 * 1024;

  for (const uri of uris.slice(0, maxCount)) {
    try {
      const ext = path.extname(uri.fsPath).toLowerCase().slice(1);
      const isVideo = VIDEO_EXTENSIONS.includes(ext);
      const maxSize = isVideo ? maxVideoSize : maxImageSize;

      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > maxSize) {
        continue;
      }

      const data = await vscode.workspace.fs.readFile(uri);
      const mime = getMimeType(ext);
      results.push(`data:${mime};base64,${Buffer.from(data).toString("base64")}`);
    } catch {
      // Skip files that can't be read
    }
  }
  return results;
};

const openFile: Handler<FilePathParams, { ok: boolean }> = async (params, ctx) => {
  const workDir = ctx.requireWorkDir();

  let absolutePath = toAbsolute(workDir, params.filePath);

  // If the path is "workDir/workDir/xxx", remove the duplicate prefix
  const doubledPrefix = path.join(workDir, workDir);
  if (absolutePath.startsWith(doubledPrefix)) {
    absolutePath = absolutePath.slice(workDir.length);
  }

  if (!isInsideWorkDir(workDir, absolutePath)) {
    return { ok: false };
  }

  const uri = vscode.Uri.file(absolutePath);
  await vscode.commands.executeCommand("vscode.open", uri);

  return { ok: true };
};

const openFileDiff: Handler<FilePathParams, { ok: boolean }> = async (params, ctx) => {
  const workDir = ctx.requireWorkDir();
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return { ok: false };
  }

  const absolutePath = toAbsolute(workDir, params.filePath);
  const currentUri = vscode.Uri.file(absolutePath);
  const baselineUri = vscode.Uri.from({
    scheme: "kimi-baseline",
    path: "/" + params.filePath,
    query: new URLSearchParams({ workDir, sessionId }).toString(),
  });

  await vscode.commands.executeCommand("vscode.diff", baselineUri, currentUri, `${path.basename(params.filePath)} (changes from Kimi)`);
  return { ok: true };
};

const trackFiles: Handler<TrackFilesParams, FileChange[]> = async (params, ctx) => {
  const workDir = ctx.requireWorkDir();
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return [];
  }

  for (const filePath of params.paths) {
    const absolutePath = toAbsolute(workDir, filePath);
    if (isInsideWorkDir(workDir, absolutePath)) {
      ctx.fileManager.trackFile(ctx.webviewId, absolutePath);
    }
  }

  const trackedFiles = ctx.fileManager.getTracked(ctx.webviewId);
  const changes = await GitManager.getChanges(workDir, sessionId, trackedFiles);
  ctx.broadcast(Events.FileChangesUpdated, changes, ctx.webviewId);
  return changes;
};

const clearTrackedFiles: Handler<void, { ok: boolean }> = async (_, ctx) => {
  ctx.fileManager.clearTracked(ctx.webviewId);
  ctx.broadcast(Events.FileChangesUpdated, [], ctx.webviewId);
  return { ok: true };
};

const revertFiles: Handler<OptionalFilePathParams, { ok: boolean }> = async (params, ctx) => {
  const workDir = ctx.requireWorkDir();
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return { ok: false };
  }

  if (params.filePath) {
    await GitManager.revertFile(workDir, sessionId, toAbsolute(workDir, params.filePath));
  } else {
    await GitManager.revertToBaseline(workDir, sessionId);
    ctx.fileManager.clearTracked(ctx.webviewId);
  }

  const trackedFiles = ctx.fileManager.getTracked(ctx.webviewId);
  const changes = await GitManager.getChanges(workDir, sessionId, trackedFiles);
  ctx.broadcast(Events.FileChangesUpdated, changes, ctx.webviewId);
  return { ok: true };
};

const keepChanges: Handler<OptionalFilePathParams, { ok: boolean }> = async (params, ctx) => {
  const workDir = ctx.requireWorkDir();
  const sessionId = ctx.getSessionId();
  if (!sessionId) {
    return { ok: false };
  }

  await GitManager.updateBaseline(workDir, sessionId);

  if (params.filePath) {
    const absolutePath = toAbsolute(workDir, params.filePath);
    ctx.fileManager.getTracked(ctx.webviewId).delete(absolutePath);
  } else {
    ctx.fileManager.clearTracked(ctx.webviewId);
  }

  const trackedFiles = ctx.fileManager.getTracked(ctx.webviewId);
  const changes = await GitManager.getChanges(workDir, sessionId, trackedFiles);
  ctx.broadcast(Events.FileChangesUpdated, changes, ctx.webviewId);
  return { ok: true };
};

const checkFileExists: Handler<CheckFileExistsParams, boolean> = async (params, ctx) => {
  if (!ctx.workDir) {
    return false;
  }
  const absolutePath = toAbsolute(ctx.workDir, params.filePath);
  return fs.existsSync(absolutePath);
};

const checkFilesExist: Handler<CheckFilesExistParams, Record<string, boolean>> = async (params, ctx) => {
  if (!ctx.workDir) {
    return {};
  }
  const result: Record<string, boolean> = {};
  for (const filePath of params.paths) {
    const absolutePath = toAbsolute(ctx.workDir, filePath);
    result[filePath] = fs.existsSync(absolutePath);
  }
  return result;
};

export const fileHandlers: Record<string, Handler<any, any>> = {
  [Methods.GetProjectFiles]: getProjectFiles,
  [Methods.GetEditorContext]: getEditorContext,
  [Methods.InsertText]: insertText,
  [Methods.PickMedia]: pickMedia,
  [Methods.OpenFile]: openFile,
  [Methods.OpenFileDiff]: openFileDiff,
  [Methods.TrackFiles]: trackFiles,
  [Methods.ClearTrackedFiles]: clearTrackedFiles,
  [Methods.RevertFiles]: revertFiles,
  [Methods.KeepChanges]: keepChanges,
  [Methods.CheckFileExists]: checkFileExists,
  [Methods.CheckFilesExist]: checkFilesExist,
};
