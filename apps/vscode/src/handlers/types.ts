import type * as vscode from "vscode";
import type { FileManager } from "../managers/file.manager";
import type { BaselineManager } from "../managers/baseline.manager";
import type { KimiHarness } from "@moonshot-ai/kimi-code-sdk";
import type { KimiRuntime } from "../runtime/kimi-runtime";
import type { SessionRuntime } from "../runtime/session-runtime";

export type BroadcastFn = (event: string, data: unknown, webviewId?: string) => void;

export type ReloadWebviewFn = (webviewId: string) => void;

export type ShowLogsFn = () => void;

export interface HandlerContext {
  webviewId: string;
  workDir: string | null;
  workDirUri: vscode.Uri | null;
  workspaceRoot: string | null;
  workspaceRootUri: vscode.Uri | null;
  workspaceState: vscode.Memento;
  requireWorkDir: () => string;
  requireWorkDirUri: () => vscode.Uri;
  broadcast: BroadcastFn;
  fileManager: FileManager;
  baselineManager: BaselineManager;
  runtime: KimiRuntime;
  harness: KimiHarness;
  reloadWebview: () => void;
  showLogs: () => void;
  logError: (message: string, error: unknown) => void;

  getSession: () => SessionRuntime | undefined;
  getSessionId: () => string | null;
  getOrCreateSession: (model: string, effort: string, sessionId?: string) => Promise<SessionRuntime>;
  resumeSession: (sessionId: string) => Promise<SessionRuntime>;
  closeSession: () => Promise<void>;
  saveAllDirty: () => Promise<void>;
  setCustomWorkDir: (workDir: string | null) => Promise<void>;
}

export type Handler<TParams = void, TResult = unknown> = (params: TParams, ctx: HandlerContext) => Promise<TResult>;
