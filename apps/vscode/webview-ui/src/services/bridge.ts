import { Methods, Events } from "shared/bridge";
import type { ApprovalResult, ContentPart, MCPServerConfig, SessionInfo, KimiConfig, AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";
import type { FileChange, SessionConfig, ExtensionConfig, WorkspaceStatus } from "shared/types";
import type { UIStreamEvent } from "shared/types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface VSCodeAPI {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeAPI;

class Bridge {
  private vscode: VSCodeAPI;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  private requestId = 0;
  private webviewId: string;

  constructor() {
    this.webviewId = document.body.getAttribute("data-webviewid") || `unknown_${Date.now()}`;

    const mockVsCodeApi: VSCodeAPI = {
      postMessage: (msg) => console.log("[Kimi Mock]", msg),
      getState: () => undefined,
      setState: () => {},
    };

    try {
      if (typeof acquireVsCodeApi === "function") {
        this.vscode = acquireVsCodeApi();
      } else {
        console.warn("[Kimi Bridge] Running outside VS Code, using mock");
        this.vscode = mockVsCodeApi;
      }
    } catch (err) {
      console.error("[Kimi Bridge] Failed to acquire VS Code API; webview may not function correctly.", err);
      this.vscode = mockVsCodeApi;
    }

    window.addEventListener("message", this.handleMessage);
  }

  private handleMessage = (event: MessageEvent) => {
    const msg = event.data;

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timeout } = this.pending.get(msg.id)!;
      if (timeout) {
        clearTimeout(timeout);
      }
      this.pending.delete(msg.id);

      if (msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg.result);
      }
      return;
    }

    if (msg.event) {
      const handlers = this.eventHandlers.get(msg.event);
      handlers?.forEach((h) => h(msg.data));
    }
  };

  private call<T>(method: string, params?: unknown, options?: { timeoutMs?: number | null }): Promise<T> {
    const id = `${++this.requestId}_${Date.now()}`;
    const timeoutMs = options?.timeoutMs === undefined ? 600000 : options.timeoutMs;

    return new Promise((resolve, reject) => {
      const timeout =
        timeoutMs && timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`Bridge ${method} timed out`));
            }, timeoutMs)
          : undefined;

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timeout });
      this.vscode.postMessage({ id, method, params, webviewId: this.webviewId });
    });
  }

  on<T>(event: string, handler: (data: T) => void): () => void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler as (data: unknown) => void);

    return () => {
      this.eventHandlers.get(event)?.delete(handler as (data: unknown) => void);
    };
  }

  checkWorkspace() {
    return this.call<WorkspaceStatus>(Methods.CheckWorkspace);
  }

  checkCLI() {
    return this.call<{ ok: boolean }>(Methods.CheckCLI);
  }

  installCLI() {
    return this.call<{ ok: boolean }>(Methods.InstallCLI);
  }

  saveConfig(sessionConfig: SessionConfig) {
    return this.call<{ ok: boolean }>(Methods.SaveConfig, sessionConfig);
  }

  setMode(mode: AgentMode) {
    return this.call<{ ok: boolean }>(Methods.SetMode, { mode });
  }

  setYoloMode(enabled: boolean) {
    return this.call<{ ok: boolean }>(Methods.SetYoloMode, { enabled });
  }

  getExtensionConfig() {
    return this.call<ExtensionConfig>(Methods.GetExtensionConfig);
  }

  openSettings() {
    return this.call<{ ok: boolean }>(Methods.OpenSettings);
  }

  reloadPlugin() {
    return this.call<{ ok: boolean }>(Methods.ReloadPlugin);
  }

  openFolder() {
    return this.call<{ ok: boolean }>(Methods.OpenFolder);
  }

  getModels() {
    return this.call<KimiConfig>(Methods.GetModels);
  }

  getMCPServers() {
    return this.call<MCPServerConfig[]>(Methods.GetMCPServers);
  }

  streamChat(content: string | ContentPart[], model: string, thinking: boolean, mode: AgentMode, sessionId?: string) {
    return this.call<{ done: boolean }>(Methods.StreamChat, { content, model, thinking, mode, sessionId }, { timeoutMs: null });
  }

  prewarmSession(model: string, thinking: boolean, mode: AgentMode) {
    return this.call<{ ok: boolean }>(Methods.PrewarmSession, { model, thinking, mode });
  }

  abortChat() {
    return this.call<{ aborted: boolean }>(Methods.AbortChat);
  }

  steerChat(content?: string | ContentPart[]) {
    return this.call<{ ok: boolean }>(Methods.SteerChat, content === undefined ? undefined : { content }, { timeoutMs: null });
  }

  resetSession() {
    return this.call<{ ok: boolean }>(Methods.ResetSession);
  }

  getProjectFiles(params?: { query?: string; directory?: string }) {
    return this.call<import("shared/types").ProjectFile[]>(Methods.GetProjectFiles, params);
  }

  getEditorContext() {
    return this.call<import("shared/types").EditorContext | null>(Methods.GetEditorContext);
  }

  insertText(text: string) {
    return this.call<void>(Methods.InsertText, { text });
  }

  respondApproval(requestId: string | number, response: ApprovalResult) {
    if (typeof response === "string") {
      return this.call<{ ok: boolean }>(Methods.RespondApproval, { requestId, response });
    }
    return this.call<{ ok: boolean }>(Methods.RespondApproval, { requestId, optionId: response.optionId });
  }

  getKimiSessions() {
    return this.call<SessionInfo[]>(Methods.GetKimiSessions);
  }

  loadSessionHistory(sessionId: string) {
    return this.call<UIStreamEvent[]>(Methods.LoadKimiSessionHistory, { kimiSessionId: sessionId });
  }

  deleteSession(sessionId: string) {
    return this.call<{ ok: boolean }>(Methods.DeleteKimiSession, { sessionId });
  }

  pickMedia(maxCount: number, includeVideo = true) {
    return this.call<string[]>(Methods.PickMedia, { maxCount, includeVideo });
  }

  checkFileExists(filePath: string) {
    return this.call<boolean>(Methods.CheckFileExists, { filePath });
  }

  checkFilesExist(paths: string[]) {
    return this.call<Record<string, boolean>>(Methods.CheckFilesExist, { paths });
  }

  openFile(filePath: string) {
    return this.call<{ ok: boolean }>(Methods.OpenFile, { filePath });
  }

  openFileDiff(filePath: string) {
    return this.call<{ ok: boolean }>(Methods.OpenFileDiff, { filePath });
  }

  trackFiles(paths: string[]) {
    return this.call<FileChange[]>(Methods.TrackFiles, { paths });
  }

  clearTrackedFiles() {
    return this.call<{ ok: boolean }>(Methods.ClearTrackedFiles);
  }

  revertFiles(filePath?: string) {
    return this.call<{ ok: boolean }>(Methods.RevertFiles, { filePath });
  }

  keepChanges(filePath?: string) {
    return this.call<{ ok: boolean }>(Methods.KeepChanges, { filePath });
  }
}

export const bridge = new Bridge();
export { Events };
