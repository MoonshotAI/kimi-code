import type { RunResult, StreamEvent } from "./legacy-sdk";

export interface SessionConfig {
  model: string;
  thinking?: boolean;
  effort?: string;
  effortChanged?: boolean;
}

export interface ProjectFile {
  path: string;
  name: string;
  isDirectory: boolean;
  matchPositions?: number[];
}

export interface FileChange {
  path: string;
  status: "Modified" | "Added" | "Deleted";
  additions: number;
  deletions: number;
}

export interface ExtensionConfig {
  yoloMode: boolean;
  autosave: boolean;
  useCtrlEnterToSend: boolean;
  enableNewConversationShortcut: boolean;
  showThinkingContent: boolean;
  showThinkingExpanded: boolean;
  version: string;
}

export interface WorkspaceStatus {
  hasWorkspace: boolean;
  path?: string;
  workspaceRoot?: string;
}

export type ErrorPhase = "preflight" | "runtime";

export interface StreamError {
  type: "error";
  code: string;
  message: string;
  detail?: string;
  providerErrorCode?: string;
  phase: ErrorPhase;
  terminal?: boolean;
}

export type UIStreamEvent =
  | { type: "session_start"; sessionId: string; model?: string; _sessionId?: string }
  | { type: "stream_complete"; result: RunResult; _sessionId?: string }
  | (StreamError & { _sessionId?: string })
  | (StreamEvent & { _sessionId?: string });

export interface LoginStatus {
  loggedIn: boolean;
  siteBase: string;
}

export type WorkspaceTarget =
  | { readonly kind: "personal" }
  | { readonly kind: "business"; readonly businessId: string };

export interface ManagedWorkspaceItem {
  readonly kind: "personal" | "business";
  readonly key: string;
  readonly businessId?: string;
  readonly name: string;
  readonly status?: string;
  readonly current: boolean;
  readonly disabled: boolean;
  readonly switchable: boolean;
  readonly roles: readonly string[];
}

export interface AccountProfileSnapshot {
  readonly nickname: string;
  readonly avatar?: string;
  readonly userLevelName: string;
  readonly hasBusinessWorkspace: boolean;
  readonly activeWorkspaceName: string;
  readonly workspaces: readonly ManagedWorkspaceItem[];
}

export type AccountProfileResponse =
  | { readonly kind: "ok"; readonly profile: AccountProfileSnapshot }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly errorCode?: string;
      readonly revoked?: boolean;
    };

export type SwitchWorkspaceResponse =
  | {
      readonly kind: "ok";
      readonly target: WorkspaceTarget;
      readonly profile?: AccountProfileSnapshot;
      readonly warning?: string;
    }
  | {
      readonly kind: "error";
      readonly message: string;
      readonly errorCode?: string;
      readonly revoked?: boolean;
    };

export type { QuestionRequest, QuestionItem, QuestionOption, QuestionResponse } from "./legacy-sdk";
