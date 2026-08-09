import * as vscode from "vscode";
import * as path from "node:path";
import { BaselineManager, type BaselineSession } from "./baseline.manager";
import { Events } from "../../shared/bridge";
import type { ProjectFile } from "../../shared/types";
import { buildCaseInsensitiveGlobLiteral } from "../utils/string";
import {
  isWorkspacePathContained,
  relativeWorkspacePath,
  resolveWorkspacePath,
} from "../utils/workspace-path";

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
  session: BaselineSession | null;
  trackedFiles: Set<string>;
}

export class FileManager {
  private viewStates = new Map<string, ViewState>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private readonly baselineManager: BaselineManager,
    private broadcast: BroadcastFn,
  ) {
    // Watch for file changes
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");

    const refresh = (uri: vscode.Uri) => {
      void this.onFileChange(uri).catch((error) => {
        console.error("[kimi-vscode] Unable to refresh file changes", error);
      });
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete(refresh);

    this.disposables.push(watcher);
  }

  private getViewState(webviewId: string): ViewState {
    let state = this.viewStates.get(webviewId);
    if (!state) {
      state = { session: null, trackedFiles: new Set() };
      this.viewStates.set(webviewId, state);
    }
    return state;
  }

  setSession(webviewId: string, session: BaselineSession): void {
    this.getViewState(webviewId).session = session;
  }

  clearSession(webviewId: string): void {
    const state = this.getViewState(webviewId);
    state.session = null;
    state.trackedFiles.clear();
  }

  getSessionId(webviewId: string): string | null {
    return this.getViewState(webviewId).session?.id ?? null;
  }

  getSession(webviewId: string): BaselineSession | null {
    return this.getViewState(webviewId).session;
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
    const absolutePath = uri.fsPath;

    for (const [webviewId, state] of this.viewStates) {
      if (!state.session || !state.trackedFiles.has(absolutePath)) {
        continue;
      }

      await this.refreshChanges(webviewId);
    }
  }

  async refreshChanges(webviewId: string): Promise<void> {
    const state = this.getViewState(webviewId);
    if (state.session === null) {
      this.broadcast(Events.FileChangesUpdated, [], webviewId);
      return;
    }
    const changes = await this.baselineManager.getChanges(state.session);
    this.broadcast(Events.FileChangesUpdated, changes, webviewId);
  }

  async searchFiles(workDirUri: vscode.Uri, query?: string): Promise<ProjectFile[]> {
    query = query ? buildCaseInsensitiveGlobLiteral(query) : "";
    const pattern = query ? `**/*${query}*` : "**/*";
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(workDirUri, pattern),
      new vscode.RelativePattern(workDirUri, SEARCH_EXCLUDE),
      200,
    );
    const results = await Promise.all(
      files.map(async (uri): Promise<ProjectFile | undefined> => {
        const relativePath = relativeWorkspacePath(workDirUri, uri);
        if (relativePath === undefined || !(await isWorkspacePathContained(workDirUri, uri))) return undefined;
        return {
          path: relativePath,
          name: path.posix.basename(relativePath),
          isDirectory: false,
        };
      }),
    );
    return results.filter((result): result is ProjectFile => result !== undefined);
  }

  async listDirectory(workDirUri: vscode.Uri, directory: string): Promise<ProjectFile[]> {
    const requested = resolveWorkspacePath(workDirUri, directory, { allowRoot: true });
    if (requested === undefined || !(await isWorkspacePathContained(workDirUri, requested.uri))) return [];
    try {
      const entries = await vscode.workspace.fs.readDirectory(requested.uri);
      const resolvedEntries = await Promise.all(
        entries.map(async ([name, type]): Promise<ProjectFile | undefined> => {
          if (shouldIgnore(name)) return undefined;
          const relativePath = requested.relativePath ? `${requested.relativePath}/${name}` : name;
          const entry = resolveWorkspacePath(workDirUri, relativePath);
          if (entry === undefined || !(await isWorkspacePathContained(workDirUri, entry.uri))) return undefined;
          return {
            path: entry.relativePath,
            name,
            isDirectory: (type & vscode.FileType.Directory) !== 0,
          };
        }),
      );
      return resolvedEntries
        .filter((entry): entry is ProjectFile => entry !== undefined)
        .toSorted((a, b) =>
          a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1,
        );
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
