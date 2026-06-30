import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "fs";
import { GitManager } from "./git.manager";
import { Events } from "../../shared/bridge";
import type { ProjectFile } from "../../shared/types";

export type BroadcastFn = (event: string, data: unknown, webviewId?: string) => void;

const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "__pycache__",
  ".cache",
  ".venv",
  "venv",
  ".gradle",
  ".idea",
  ".DS_Store",
  "Thumbs.db",
  "coverage",
  ".nyc_output",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".eggs",
  ".sass-cache",
  ".parcel-cache",
  "bower_components",
  "jspm_packages",
  ".turbo",
]);

const IGNORE_EXT = new Set([".lock", ".log", ".map", ".min.js", ".min.css", ".chunk.js", ".chunk.css"]);

function shouldIgnore(name: string): boolean {
  if (IGNORE_DIRS.has(name)) {
    return true;
  }
  const ext = path.extname(name).toLowerCase();
  return IGNORE_EXT.has(ext);
}

const SEARCH_EXCLUDE = `{${[...IGNORE_DIRS].map((d) => `**/${d}`).join(",")}}`;

interface ViewState {
  sessionId: string | null;
  trackedFiles: Set<string>;
}

export class FileManager {
  private viewStates = new Map<string, ViewState>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private getWorkDir: () => string | null,
    private broadcast: BroadcastFn,
  ) {
    // Watch for file changes
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");

    watcher.onDidChange((uri) => this.onFileChange(uri));
    watcher.onDidCreate((uri) => this.onFileChange(uri));
    watcher.onDidDelete((uri) => this.onFileChange(uri));

    this.disposables.push(watcher);
  }

  private getViewState(webviewId: string): ViewState {
    let state = this.viewStates.get(webviewId);
    if (!state) {
      state = { sessionId: null, trackedFiles: new Set() };
      this.viewStates.set(webviewId, state);
    }
    return state;
  }

  setSessionId(webviewId: string, sessionId: string): void {
    this.getViewState(webviewId).sessionId = sessionId;
  }

  getSessionId(webviewId: string): string | null {
    return this.getViewState(webviewId).sessionId;
  }

  trackFile(webviewId: string, absolutePath: string): void {
    this.getViewState(webviewId).trackedFiles.add(absolutePath);
  }

  getTracked(webviewId: string): Set<string> {
    return this.getViewState(webviewId).trackedFiles;
  }

  clearTracked(webviewId: string): void {
    this.getViewState(webviewId).trackedFiles.clear();
  }

  disposeView(webviewId: string): void {
    this.viewStates.delete(webviewId);
  }

  private async onFileChange(uri: vscode.Uri): Promise<void> {
    const workDir = this.getWorkDir();
    if (!workDir) {
      return;
    }

    const absolutePath = uri.fsPath;

    for (const [webviewId, state] of this.viewStates) {
      if (!state.sessionId || !state.trackedFiles.has(absolutePath)) {
        continue;
      }

      const changes = await GitManager.getChanges(workDir, state.sessionId, state.trackedFiles);
      this.broadcast(Events.FileChangesUpdated, changes, webviewId);
    }
  }

  async searchFiles(query?: string): Promise<ProjectFile[]> {
    const pattern = query ? `**/*${query}*` : "**/*";
    const files = await vscode.workspace.findFiles(pattern, SEARCH_EXCLUDE, 100);

    return files.map((uri) => ({
      path: vscode.workspace.asRelativePath(uri),
      name: path.basename(uri.fsPath),
      isDirectory: false,
    }));
  }

  async listDirectory(workDir: string, directory: string): Promise<ProjectFile[]> {
    const dirPath = directory ? path.join(workDir, directory) : workDir;
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((e) => !shouldIgnore(e.name))
        .map((e) => ({
          path: directory ? path.join(directory, e.name) : e.name,
          name: e.name,
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1));
    } catch {
      return [];
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
    this.viewStates.clear();
  }
}
