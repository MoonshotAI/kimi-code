/**
 * `workspaceRegistry` domain (L2) — workspace read-model query contract.
 *
 * Defines `IWorkspaceQueryService`, an App-scope read facade that answers
 * workspace-centric queries spanning the workspace catalog and the session
 * index. Today it exposes the most recent sessions in a workspace, projected
 * as the session index's `SessionSummary`. Read-only and JSON-in/JSON-out so
 * it is directly exposable on the `/api/v2` transport. App-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { SessionSummary } from '#/app/sessionIndex/sessionIndex';

export type { SessionSummary };

export const RECENT_SESSIONS_LIMIT = 20;

export interface IWorkspaceQueryService {
  readonly _serviceBrand: undefined;

  listRecentSessions(workspaceId: string): Promise<readonly SessionSummary[]>;
}

export const IWorkspaceQueryService: ServiceIdentifier<IWorkspaceQueryService> =
  createDecorator<IWorkspaceQueryService>('workspaceQuery');
