import type { IDisposable, Workspace } from '@moonshot-ai/agent-core-v2';

import type { ServerMessage, WorkspaceInfo } from '../../../protocol/messages';

export interface WsV3Logger {
  warn(obj: unknown, msg: string): void;
}

export interface WsV3Projection {
  onMessage(
    sessionId: string,
    listener: (message: ServerMessage) => void,
  ): IDisposable | undefined;
  recoveryMessages(sessionId: string): ServerMessage[];
}

export interface WsV3SessionLifecycle {
  onDidCreateSession(listener: (event: { readonly sessionId: string }) => void): IDisposable;
  sessionExists(sessionId: string): Promise<boolean>;
}

export interface WsV3CoreEvent {
  readonly type: string;
  readonly payload?: unknown;
}

export interface WsV3GlobalSource {
  subscribe(listener: (event: WsV3CoreEvent) => void): IDisposable;
  listWorkspaces(): Promise<readonly Workspace[]>;
  workspaceInfo(workspace: Workspace): Promise<WorkspaceInfo>;
  sessionInfo(sessionId: string): Promise<unknown>;
}
