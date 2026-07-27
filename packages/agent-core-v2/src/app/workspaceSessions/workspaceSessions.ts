/**
 * `workspaceSessions` domain (L2) — workspace ↔ session query contract.
 *
 * Defines `IWorkspaceSessions`, an App-scope read facade answering
 * workspace-centric queries over the session index: the most recent sessions
 * of a workspace and its total session count. Every query first folds the
 * workspace id through `IWorkspaceAliases` so legacy split buckets (one
 * directory, several id spellings) answer as one workspace. Read-only and
 * JSON-in/JSON-out so it is directly exposable on the `/api/v2` transport.
 * App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';

export type { SessionSummary };

export const RECENT_SESSIONS_LIMIT = 20;

export interface IWorkspaceSessions {
  readonly _serviceBrand: undefined;

  listRecent(workspaceId: string): Promise<readonly SessionSummary[]>;
  count(workspaceId: string): Promise<number>;
}

export const IWorkspaceSessions: ServiceIdentifier<IWorkspaceSessions> =
  createDecorator<IWorkspaceSessions>('workspaceSessions');
