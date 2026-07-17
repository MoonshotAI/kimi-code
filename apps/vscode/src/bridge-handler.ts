import * as path from "node:path";
import * as vscode from "vscode";

import {
  validateRpcMessage,
  type RpcMethod,
  type RpcResult,
} from "../shared/bridge";
import { VSCodeSettings } from "./config/vscode-settings";
import { handlers, type BroadcastFn, type HandlerContext, type ReloadWebviewFn, type ShowLogsFn } from "./handlers";
import { BaselineManager, type BaselineSession } from "./managers/baseline.manager";
import { FileManager } from "./managers/file.manager";
import { KimiRuntime } from "./runtime/kimi-runtime";
import type { SessionRuntime } from "./runtime/session-runtime";
import { areSameFsPath } from "./utils/fs-path";
import {
  isWorkspacePathContained,
  isWorkspacePathContainedSync,
  relativeWorkspacePath,
  resolveWorkspacePath,
  type WorkspacePath,
  workDirUriFromPath,
} from "./utils/workspace-path";

export class BridgeHandler {
  readonly baselineManager: BaselineManager;
  readonly runtime: KimiRuntime;

  private readonly customWorkDirs = new Map<string, string>();
  private readonly fileManager: FileManager;

  constructor(
    private readonly broadcast: BroadcastFn,
    private readonly workspaceState: vscode.Memento,
    globalStoragePath: string,
    private readonly reloadWebview: ReloadWebviewFn,
    private readonly showLogs: ShowLogsFn,
    private readonly writeLog: (message: string) => void,
  ) {
    this.runtime = new KimiRuntime({
      version: VSCodeSettings.getExtensionConfig().version,
      broadcast,
      captureBaseline: (session, filePath, webviewIds) => {
        this.captureFileBaseline(session, filePath, webviewIds);
      },
      log: (message, error) => this.logRuntimeError(message, error),
    });
    this.baselineManager = new BaselineManager(globalStoragePath, this.runtime.harness.homeDir);
    this.fileManager = new FileManager(this.baselineManager, broadcast);
  }

  async handle(value: unknown, webviewId: string): Promise<RpcResult> {
    const startedAt = Date.now();
    const validation = validateRpcMessage(value);
    if (!validation.ok) {
      this.trace(validation.id, validation.method, Date.now() - startedAt, false);
      this.logRuntimeError(`Bridge request rejected: ${validation.method}`, validation.error);
      return { id: validation.id, error: validation.error };
    }

    const msg = validation.message;
    try {
      const result = await this.dispatch(msg.method, msg.params, webviewId);
      this.trace(msg.id, msg.method, Date.now() - startedAt, true);
      return { id: msg.id, result };
    } catch (error) {
      this.trace(msg.id, msg.method, Date.now() - startedAt, false);
      this.logRuntimeError(`Bridge request failed: ${msg.method}`, error);
      return {
        id: msg.id,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private get workspaceRoot(): string | null {
    return this.workspaceRootUri?.fsPath ?? null;
  }

  private get workspaceRootUri(): vscode.Uri | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri ?? null;
  }

  private getWorkDir(webviewId: string): string | null {
    return this.customWorkDirs.get(webviewId) ?? this.workspaceRoot;
  }

  private getWorkDirUri(webviewId: string): vscode.Uri | null {
    const workspaceRoot = this.workspaceRoot;
    const workspaceRootUri = this.workspaceRootUri;
    const workDir = this.getWorkDir(webviewId);
    if (workspaceRoot === null || workspaceRootUri === null || workDir === null) return null;
    return workDirUriFromPath(workspaceRootUri, workspaceRoot, workDir) ?? null;
  }

  private async setCustomWorkDir(webviewId: string, workDir: string | null): Promise<void> {
    const workspaceRoot = this.workspaceRoot;
    const workspaceRootUri = this.workspaceRootUri;
    if (workspaceRoot === null || workspaceRootUri === null) throw new Error("No workspace folder open");
    if (workDir !== null) {
      const workDirUri = workDirUriFromPath(workspaceRootUri, workspaceRoot, workDir);
      if (workDirUri === undefined || !(await isWorkspacePathContained(workspaceRootUri, workDirUri))) {
        throw new Error("Working directory must be within the workspace");
      }
    }
    if (workDir && workDir !== this.workspaceRoot) {
      this.customWorkDirs.set(webviewId, workDir);
    } else {
      this.customWorkDirs.delete(webviewId);
    }
    await this.runtime.detachView(webviewId);
    this.fileManager.clearSession(webviewId);
  }

  private requireWorkDir(webviewId: string): string {
    const workDir = this.getWorkDir(webviewId);
    if (!workDir) throw new Error("No workspace folder open");
    return workDir;
  }

  private requireWorkDirUri(webviewId: string): vscode.Uri {
    const workDirUri = this.getWorkDirUri(webviewId);
    if (!workDirUri) throw new Error("No workspace folder open");
    return workDirUri;
  }

  private async dispatch(method: RpcMethod, params: unknown, webviewId: string): Promise<unknown> {
    if (!Object.hasOwn(handlers, method)) throw new Error(`Unknown method: ${method}`);
    const handler = handlers[method];
    if (!handler) throw new Error(`Unknown method: ${method}`);
    return handler(params, this.createContext(webviewId));
  }

  private createContext(webviewId: string): HandlerContext {
    return {
      webviewId,
      workDir: this.getWorkDir(webviewId),
      workDirUri: this.getWorkDirUri(webviewId),
      workspaceRoot: this.workspaceRoot,
      workspaceRootUri: this.workspaceRootUri,
      workspaceState: this.workspaceState,
      requireWorkDir: () => this.requireWorkDir(webviewId),
      requireWorkDirUri: () => this.requireWorkDirUri(webviewId),
      broadcast: this.broadcast,
      fileManager: this.fileManager,
      baselineManager: this.baselineManager,
      runtime: this.runtime,
      harness: this.runtime.harness,
      reloadWebview: () => this.reloadWebview(webviewId),
      showLogs: this.showLogs,
      logError: (message, error) => this.logRuntimeError(message, error),
      getSession: () => this.runtime.getSessionForView(webviewId),
      getSessionId: () => this.fileManager.getSessionId(webviewId),
      getOrCreateSession: async (model, effort, sessionId) => {
        const runtime = await this.runtime.openSession({
          webviewId,
          workDir: this.requireWorkDir(webviewId),
          model,
          effort,
          yoloMode: VSCodeSettings.yoloMode,
          ...(sessionId === undefined ? {} : { sessionId }),
        });
        this.fileManager.setSession(webviewId, baselineSession(runtime));
        return runtime;
      },
      resumeSession: async (sessionId) => {
        const current = this.runtime.getSession(sessionId);
        const session =
          current?.session ??
          (await this.runtime.harness.resumeSession({ id: sessionId, includeSubagents: true }));
        if (!areSameFsPath(session.workDir, this.requireWorkDir(webviewId))) {
          if (current === undefined) {
            await session.close().catch((error: unknown) => {
              this.logRuntimeError("Unable to close a rejected session", error);
            });
          }
          throw new Error("The selected session belongs to a different working directory.");
        }
        const runtime = await this.runtime.attachResumedSession(
          webviewId,
          session,
          VSCodeSettings.yoloMode,
        );
        this.fileManager.setSession(webviewId, baselineSession(runtime));
        return runtime;
      },
      closeSession: async () => {
        await this.runtime.detachView(webviewId);
        this.fileManager.clearSession(webviewId);
      },
      saveAllDirty: () => this.saveAllDirty(),
      setCustomWorkDir: (workDir) => this.setCustomWorkDir(webviewId, workDir),
    };
  }

  private async saveAllDirty(): Promise<void> {
    const dirty = vscode.workspace.textDocuments.filter((document) => document.isDirty && !document.isUntitled);
    await Promise.all(dirty.map((document) => document.save()));
  }

  async disposeView(webviewId: string): Promise<void> {
    await this.runtime.detachView(webviewId);
    this.customWorkDirs.delete(webviewId);
    this.fileManager.disposeView(webviewId);
  }

  async getEditorMention(
    webviewId: string,
    documentUri: vscode.Uri,
    selection: vscode.Selection,
  ): Promise<string | null> {
    const workDirUri = this.getWorkDirUri(webviewId);
    // Mirror the CLI/TUI: no UI-level directory gate on mentions. Inside the
    // working directory the mention is relative; outside it (for example a
    // file under the session's additionalDirs) it falls back to the absolute
    // path, and the session's tool layer decides readability. Virtual
    // documents (untitled:, git:, ...) have no meaningful path to mention.
    if (workDirUri === null || documentUri.scheme !== workDirUri.scheme) return null;
    const filePath = relativeWorkspacePath(workDirUri, documentUri) ?? documentUri.fsPath;
    // Quote paths containing spaces, as the CLI/TUI mention completers do, so
    // whitespace cannot split the path; any line range goes after the quote.
    const mentionTarget = filePath.includes(" ") ? `"${filePath}"` : filePath;

    if (selection.isEmpty) return `@${mentionTarget}`;
    return selection.start.line === selection.end.line
      ? `@${mentionTarget}:${selection.start.line + 1}`
      : `@${mentionTarget}:${selection.start.line + 1}-${selection.end.line + 1}`;
  }

  captureFileBaseline(
    session: BaselineSession,
    filePath: string,
    webviewIds: readonly string[],
  ): void {
    const workspaceRoot = this.workspaceRoot;
    const workspaceRootUri = this.workspaceRootUri;
    if (workspaceRoot === null || workspaceRootUri === null) return;

    const workDirUri = workDirUriFromPath(workspaceRootUri, workspaceRoot, session.workDir);
    if (
      workDirUri === undefined ||
      !isWorkspacePathContainedSync(workspaceRootUri, workDirUri)
    ) {
      this.logRuntimeError(
        "Unable to capture a file baseline",
        new Error("Session working directory is outside the workspace"),
      );
      return;
    }

    const resolved = resolveSessionFilePath(workDirUri, session.workDir, filePath);
    if (
      resolved === undefined ||
      !isWorkspacePathContainedSync(workDirUri, resolved.uri, { allowMissing: true })
    ) {
      this.logRuntimeError(
        "Unable to capture a file baseline",
        new Error("File is outside the session working directory"),
      );
      return;
    }

    const capture = this.baselineManager.capture(session, resolved.uri.fsPath);
    void capture
      .then(async () => {
        await Promise.all(
          webviewIds.map(async (webviewId) => {
            this.fileManager.trackFile(webviewId, resolved.uri.fsPath);
            await this.fileManager.refreshChanges(webviewId);
          }),
        );
      })
      .catch((error) => {
        this.logRuntimeError("Unable to capture a file baseline", error);
      });
  }

  async dispose(): Promise<void> {
    this.fileManager.dispose();
    await this.runtime.dispose();
  }

  async getBaselineContent(sessionId: string, filePath: string): Promise<string> {
    const active = this.runtime.getSession(sessionId)?.summary;
    const summary = active ?? (await this.runtime.harness.listSessions({ sessionId }))[0];
    if (summary === undefined) throw new Error("Session was not found.");
    return this.baselineManager.getContent(baselineSummary(summary), filePath);
  }

  private trace(id: string, method: string, durationMs: number, ok: boolean): void {
    // Deliberately exclude params, prompt text, file paths, and credentials.
    const line = `[bridge] id=${id} method=${method} ok=${String(ok)} durationMs=${durationMs}`;
    console.debug(`[kimi-vscode] ${line}`);
    this.writeLog(line);
  }

  private logRuntimeError(message: string, error?: unknown): void {
    const detail = errorDetail(error);
    const line = `${message}${detail ? `: ${detail}` : ""}`;
    console.error(`[kimi-vscode] ${line}`);
    this.writeLog(line);
  }
}

function errorDetail(error: unknown): string {
  if (error === undefined) return "";
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "bigint" || typeof error === "boolean") {
    return String(error);
  }
  return "Unknown error";
}

function baselineSession(runtime: SessionRuntime): BaselineSession {
  return baselineSummary({
    id: runtime.id,
    workDir: runtime.session.workDir,
    metadata: runtime.summary?.metadata,
  });
}

function baselineSummary(summary: Pick<BaselineSession, "id" | "workDir" | "metadata">): BaselineSession {
  return {
    id: summary.id,
    workDir: summary.workDir,
    ...(summary.metadata === undefined ? {} : { metadata: summary.metadata }),
  };
}

function resolveSessionFilePath(
  workDirUri: vscode.Uri,
  workDir: string,
  filePath: string,
): WorkspacePath | undefined {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    const uri = workDirUriFromPath(workDirUri, workDir, filePath);
    if (uri === undefined) return undefined;
    const relativePath = relativeWorkspacePath(workDirUri, uri);
    return relativePath === undefined ? undefined : { uri, relativePath };
  }
  return resolveWorkspacePath(workDirUri, filePath);
}
