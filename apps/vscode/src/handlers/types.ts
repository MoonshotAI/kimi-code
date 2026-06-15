import type { FileManager } from "../managers/file.manager";
import type { Session, Turn, AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";

export type BroadcastFn = (event: string, data: unknown, webviewId?: string) => void;

export interface HandlerContext {
  webviewId: string;
  workDir: string | null;
  requireWorkDir: () => string;
  broadcast: BroadcastFn;
  fileManager: FileManager;

  getSession: () => Session | undefined;
  getSessionId: () => string | null;
  getTurn: () => Turn | undefined;
  setTurn: (turn: Turn | null) => void;
  getSessionGeneration: () => number;
  bumpSessionGeneration: () => number;
  isSessionGeneration: (generation: number) => boolean;
  getOrCreateSession: (model: string, thinking: boolean, mode: AgentMode, sessionId?: string) => Promise<Session>;
  prewarmSession: (model: string, thinking: boolean, mode: AgentMode) => Promise<void>;
  closeSession: () => Promise<void>;
  saveAllDirty: () => Promise<void>;
  reloadWebview: () => void;
  setLoggedIn: (loggedIn: boolean) => void;
}

export type Handler<TParams = void, TResult = unknown> = (params: TParams, ctx: HandlerContext) => Promise<TResult>;
