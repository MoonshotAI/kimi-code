import { Methods, Events } from "shared/bridge";
import type {
  ApprovalResponse,
  ContentPart,
  MCPServerConfig,
  SessionInfo,
  KimiConfig,
  MCPTestResult,
  LoginResult,
  UpdateMCPServerRequest,
} from "shared/legacy-sdk";
import type {
  FileChange,
  SessionConfig,
  ExtensionConfig,
  WorkspaceStatus,
  LoginStatus,
  UIStreamEvent,
} from "shared/types";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const OAUTH_REQUEST_TIMEOUT_MS = 16 * 60 * 1000;

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

    if (typeof acquireVsCodeApi === "function") {
      this.vscode = acquireVsCodeApi();
    } else {
      console.warn("[Kimi Bridge] Running outside VS Code, using mock");
      this.vscode = {
        postMessage: (msg) => console.log("[Kimi Mock]", msg),
        getState: () => undefined,
        setState: () => {},
      };
    }

    window.addEventListener("message", this.handleMessage);
  }

  private handleMessage = (event: MessageEvent) => {
    const msg = event.data;

    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timeout } = this.pending.get(msg.id)!;
      clearTimeout(timeout);
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

  private call<T>(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    const id = `${++this.requestId}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge ${method} timed out`));
      }, timeoutMs);

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

  getInputHistory() {
    return this.call<string[]>(Methods.GetInputHistory);
  }

  addInputHistory(text: string) {
    return this.call<{ ok: boolean }>(Methods.AddInputHistory, { text });
  }

  getSlashCommands() {
    return this.call<import("shared/legacy-sdk").SlashCommandInfo[]>(Methods.GetSlashCommands);
  }

  checkLoginStatus() {
    return this.call<LoginStatus>(Methods.CheckLoginStatus);
  }

  login() {
    return this.call<LoginResult>(Methods.Login, undefined, OAUTH_REQUEST_TIMEOUT_MS);
  }

  logout() {
    return this.call<LoginResult>(Methods.Logout);
  }

  saveConfig(sessionConfig: SessionConfig) {
    return this.call<{ ok: boolean }>(Methods.SaveConfig, sessionConfig);
  }

  getExtensionConfig() {
    return this.call<ExtensionConfig>(Methods.GetExtensionConfig);
  }

  openSettings() {
    return this.call<{ ok: boolean }>(Methods.OpenSettings);
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

  addMCPServer(serverConfig: MCPServerConfig) {
    return this.call<MCPServerConfig[]>(Methods.AddMCPServer, serverConfig);
  }

  updateMCPServer(originalName: string, serverConfig: MCPServerConfig) {
    const request: UpdateMCPServerRequest = { originalName, server: serverConfig };
    return this.call<MCPServerConfig[]>(Methods.UpdateMCPServer, request);
  }

  removeMCPServer(name: string) {
    return this.call<MCPServerConfig[]>(Methods.RemoveMCPServer, { name });
  }

  authMCP(name: string) {
    return this.call<{ ok: boolean }>(Methods.AuthMCP, { name }, OAUTH_REQUEST_TIMEOUT_MS);
  }

  resetAuthMCP(name: string) {
    return this.call<{ ok: boolean }>(Methods.ResetAuthMCP, { name });
  }

  testMCP(name: string) {
    return this.call<MCPTestResult>(Methods.TestMCP, { name });
  }

  streamChat(content: string | ContentPart[], model: string, effort: string, planMode: boolean, sessionId?: string) {
    return this.call<{ done: boolean }>(Methods.StreamChat, { content, model, effort, planMode, sessionId });
  }

  abortChat() {
    return this.call<{ aborted: boolean }>(Methods.AbortChat);
  }

  resetSession() {
    return this.call<{ ok: boolean }>(Methods.ResetSession);
  }

  getProjectFiles(params?: { query?: string; directory?: string }) {
    return this.call<import("shared/types").ProjectFile[]>(Methods.GetProjectFiles, params);
  }

  respondApproval(requestId: string, response: ApprovalResponse) {
    return this.call<{ ok: boolean }>(Methods.RespondApproval, { requestId, response });
  }

  respondQuestion(rpcRequestId: string, questionRequestId: string, answers: Record<string, string>) {
    return this.call<{ ok: boolean }>(Methods.RespondQuestion, { rpcRequestId, questionRequestId, answers });
  }

  getKimiSessions() {
    return this.call<SessionInfo[]>(Methods.GetKimiSessions);
  }

  getAllKimiSessions() {
    return this.call<SessionInfo[]>(Methods.GetAllKimiSessions);
  }

  getRegisteredWorkDirs() {
    return this.call<string[]>(Methods.GetRegisteredWorkDirs);
  }

  setWorkDir(workDir: string | null) {
    return this.call<{ ok: boolean; workDir: string }>(Methods.SetWorkDir, { workDir });
  }

  browseWorkDir() {
    return this.call<{ ok: boolean; workDir: string | null }>(Methods.BrowseWorkDir);
  }

  loadSessionHistory(sessionId: string) {
    return this.call<UIStreamEvent[]>(Methods.LoadKimiSessionHistory, { kimiSessionId: sessionId });
  }

  deleteSession(sessionId: string) {
    return this.call<{ ok: boolean }>(Methods.DeleteKimiSession, { sessionId });
  }

  forkSession(sessionId: string, turnIndex: number) {
    return this.call<{ sessionId: string } | null>(Methods.ForkKimiSession, { sessionId, turnIndex });
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

  getImageDataUri(filePath: string) {
    return this.call<string | null>(Methods.GetImageDataUri, { filePath });
  }

  setPlanMode(enabled: boolean) {
    return this.call<{ ok: boolean; planMode: boolean }>(Methods.SetPlanMode, { enabled });
  }

  steerChat(content: string | ContentPart[]) {
    return this.call<{ ok: boolean }>(Methods.SteerChat, { content });
  }

  showLogs() {
    return this.call<{ ok: boolean }>(Methods.ShowLogs);
  }

  reloadWebview() {
    return this.call<{ ok: boolean }>(Methods.ReloadWebview);
  }
}

export const bridge = new Bridge();
export { Events };
