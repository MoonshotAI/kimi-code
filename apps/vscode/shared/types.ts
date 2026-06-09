import type { RunResult, StreamEvent, ContentPart, AgentMode } from "@moonshot-ai/kimi-code-vscode-agent-sdk";

export interface SessionConfig {
  model: string;
  thinking?: boolean;
}

export interface ProjectFile {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface EditorContext {
  content: string;
  language: string;
  fileName: string;
  selection?: {
    text: string;
    startLine: number;
    endLine: number;
  };
}

export interface FileChange {
  path: string;
  status: "Modified" | "Added" | "Deleted";
  additions: number;
  deletions: number;
}

export interface ExtensionConfig {
  executablePath: string;
  yoloMode: boolean;
  autosave: boolean;
  useCtrlEnterToSend: boolean;
  enableNewConversationShortcut: boolean;
  environmentVariables: Record<string, string>;
}

export interface WorkspaceStatus {
  hasWorkspace: boolean;
  path?: string;
}

// Error handling types
export type ErrorPhase = "preflight" | "runtime";

export interface StreamError {
  type: "error";
  code: string;
  message: string;
  phase: ErrorPhase;
  details?: Record<string, unknown>;
  raw?: string;
}

export interface InlineError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PendingInput {
  content: string | ContentPart[];
  model: string;
  mode: AgentMode;
}

export type UIStreamEvent = { type: "session_start"; sessionId: string; model?: string } | { type: "stream_complete"; result: RunResult } | StreamError | StreamEvent;
