/**
 * `workspaceRegistry` domain (L2) — workspace read-model query contract.
 *
 * Defines `IWorkspaceQueryService`, an App-scope read facade that answers
 * workspace-centric queries spanning the workspace catalog and the session
 * index. Today it exposes the most recent sessions in a workspace, projected
 * as the session index's `SessionSummary`. Read-only and JSON-in/JSON-out so
 * it can be exposed by the server's `/api/v1` compatibility routes. App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';

import type { Workspace } from './workspaceRegistry';

export type { SessionSummary };

export const RECENT_SESSIONS_LIMIT = 20;

export interface WorkspaceListItem extends Workspace {
  readonly sessionCount: number;
}

export interface IWorkspaceQueryService {
  readonly _serviceBrand: undefined;

  list(): Promise<readonly WorkspaceListItem[]>;
  get(workspaceId: string): Promise<Workspace | undefined>;
  listSessions(
    workspaceId: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<readonly SessionSummary[]>;
  countActiveSessions(workspaceId: string): Promise<number>;
  listRecentSessions(workspaceId: string): Promise<readonly SessionSummary[]>;
}

export const IWorkspaceQueryService: ServiceIdentifier<IWorkspaceQueryService> =
  createDecorator<IWorkspaceQueryService>('workspaceQuery');
