import * as vscode from "vscode";
import { VSCodeSettings } from "./config/vscode-settings";
import { getCLIManager, FileManager, GitManager } from "./managers";
import { handlers, type HandlerContext, type BroadcastFn } from "./handlers";
import { createSession, parseConfig, getModelThinkingMode, getModelById, type Session, type Turn, type AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";

interface RpcMessage {
  id: string;
  method: string;
  params?: unknown;
}

interface RpcResult {
  id: string;
  result?: unknown;
  error?: string;
}

export class BridgeHandler {
  private sessions = new Map<string, Session>();
  private turns = new Map<string, Turn>();
  private sessionGenerations = new Map<string, number>();
  private prewarmSessions = new Map<string, { signature: string; promise: Promise<void> }>();
  private fileManager: FileManager;

  constructor(
    private broadcast: BroadcastFn,
    private reloadWebviewCb: (webviewId: string) => void,
  ) {
    this.fileManager = new FileManager(() => this.workDir, broadcast);
  }

  async handle(msg: RpcMessage, webviewId: string): Promise<RpcResult> {
    try {
      return {
        id: msg.id,
        result: await this.dispatch(msg.method, msg.params, webviewId),
      };
    } catch (err) {
      return {
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private get workDir(): string | null {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;
  }

  private requireWorkDir(): string {
    const w = this.workDir;
    if (!w) {
      throw new Error("No workspace folder open");
    }
    return w;
  }

  private getSessionGeneration(webviewId: string): number {
    return this.sessionGenerations.get(webviewId) ?? 0;
  }

  private bumpSessionGeneration(webviewId: string): number {
    const next = this.getSessionGeneration(webviewId) + 1;
    this.sessionGenerations.set(webviewId, next);
    return next;
  }

  private isSessionGeneration(webviewId: string, generation: number): boolean {
    return this.getSessionGeneration(webviewId) === generation;
  }

  private async dispatch(method: string, params: unknown, webviewId: string): Promise<unknown> {
    const handler = handlers[method];
    if (!handler) {
      throw new Error(`Unknown method: ${method}`);
    }
    return handler(params, this.createContext(webviewId));
  }

  private createContext(webviewId: string): HandlerContext {
    return {
      webviewId,
      workDir: this.workDir,
      requireWorkDir: () => this.requireWorkDir(),
      broadcast: this.broadcast,
      fileManager: this.fileManager,
      getSession: () => this.sessions.get(webviewId),
      getSessionId: () => this.fileManager.getSessionId(webviewId),
      getTurn: () => this.turns.get(webviewId),
      setTurn: (turn: Turn | null) => {
        if (turn) {
          this.turns.set(webviewId, turn);
        } else {
          this.turns.delete(webviewId);
        }
      },
      getSessionGeneration: () => this.getSessionGeneration(webviewId),
      bumpSessionGeneration: () => this.bumpSessionGeneration(webviewId),
      isSessionGeneration: (generation) => this.isSessionGeneration(webviewId, generation),
      getOrCreateSession: async (model, thinking, mode, sessionId) => this.getOrCreateSession(webviewId, model, thinking, mode, sessionId),
      prewarmSession: async (model, thinking, mode) => this.prewarmSession(webviewId, model, thinking, mode),
      closeSession: async () => {
        const session = this.sessions.get(webviewId);
        this.sessions.delete(webviewId);
        this.turns.delete(webviewId);
        this.prewarmSessions.delete(webviewId);
        if (session) {
          GitManager.clearBaseline(session.workDir, session.sessionId);
          void session.close().catch((err) => {
            console.warn("[bridge] Error closing old session:", err);
          });
        }
      },
      saveAllDirty: () => this.saveAllDirty(),
      reloadWebview: () => this.reloadWebviewCb(webviewId),
      setLoggedIn: (loggedIn: boolean) => {
        vscode.commands.executeCommand("setContext", "kimi.isLoggedIn", loggedIn);
      },
    };
  }

  private resolveActualThinking(model: string, thinking: boolean): boolean {
    const config = parseConfig();
    const modelConfig = getModelById(config.models, model);
    const thinkingMode = modelConfig ? getModelThinkingMode(modelConfig) : "none";

    if (thinkingMode === "always") {
      return true;
    }
    if (thinkingMode === "none") {
      return false;
    }
    return thinking;
  }

  private getSessionConfigSignature(model: string, thinking: boolean, mode: AgentMode, executable: string, env: Record<string, string>): string {
    return JSON.stringify({ model, thinking, mode, executable, env });
  }

  private async prewarmSession(webviewId: string, model: string, thinking: boolean, mode: AgentMode): Promise<void> {
    const cli = getCLIManager();
    const executable = cli.getExecutablePath();
    const env = VSCodeSettings.environmentVariables;
    const actualThinking = this.resolveActualThinking(model, thinking);
    const signature = this.getSessionConfigSignature(model, actualThinking, mode, executable, env);

    const existing = this.sessions.get(webviewId);
    if (existing) {
      const existingSignature = this.getSessionConfigSignature(existing.model ?? model, existing.thinking, existing.mode, existing.executable, existing.env);
      if (existingSignature === signature) {
        return;
      }
    }

    const currentPrewarm = this.prewarmSessions.get(webviewId);
    if (currentPrewarm?.signature === signature) {
      return currentPrewarm.promise;
    }

    const promise = (async () => {
      const session = await this.getOrCreateSession(webviewId, model, thinking, mode);
      await session.ensureStarted();
    })().finally(() => {
      if (this.prewarmSessions.get(webviewId)?.promise === promise) {
        this.prewarmSessions.delete(webviewId);
      }
    });

    this.prewarmSessions.set(webviewId, { signature, promise });
    return promise;
  }

  private async saveAllDirty(): Promise<void> {
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty && !d.isUntitled);
    await Promise.all(dirty.map((d) => d.save()));
  }

  private async getOrCreateSession(webviewId: string, model: string, thinking: boolean, mode: AgentMode, sessionId?: string): Promise<Session> {
    const workDir = this.requireWorkDir();
    const cli = getCLIManager();
    const actualThinking = this.resolveActualThinking(model, thinking);

    const executable = cli.getExecutablePath();
    const env = VSCodeSettings.environmentVariables;

    const existing = this.sessions.get(webviewId);

    // Check if we need to restart the session
    if (existing) {
      const needsRestart =
        (sessionId && sessionId !== existing.sessionId) ||
        executable !== existing.executable ||
        JSON.stringify(env) !== JSON.stringify(existing.env);

      if (needsRestart) {
        // Reuse of the same webview session still serializes lifetime so config/env
        // changes do not overlap old and new CLI processes. User-initiated new
        // conversations go through closeSession(), which is intentionally non-blocking.
        GitManager.clearBaseline(existing.workDir, existing.sessionId);
        await existing.close();
        this.sessions.delete(webviewId);
        this.turns.delete(webviewId);
      } else {
        existing.model = model;
        existing.thinking = actualThinking;
        existing.mode = mode;
      }
    }

    const current = this.sessions.get(webviewId);
    if (current) {
      return current;
    }

    const session = createSession({
      workDir,
      model,
      thinking: actualThinking,
      mode,
      sessionId,
      executable,
      env,
    });

    this.sessions.set(webviewId, session);
    return session;
  }

  async disposeView(webviewId: string): Promise<void> {
    const session = this.sessions.get(webviewId);
    if (session) {
      GitManager.clearBaseline(session.workDir, session.sessionId);
      await session.close();
    }
    this.sessions.delete(webviewId);
    this.turns.delete(webviewId);
    this.sessionGenerations.delete(webviewId);
    this.prewarmSessions.delete(webviewId);
    this.fileManager.disposeView(webviewId);
  }

  async dispose(): Promise<void> {
    this.fileManager.dispose();
    for (const s of this.sessions.values()) {
      await s.close();
    }
    this.sessions.clear();
    this.turns.clear();
    this.sessionGenerations.clear();
    this.prewarmSessions.clear();
  }
}
