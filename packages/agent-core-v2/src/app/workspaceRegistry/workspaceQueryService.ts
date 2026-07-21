/**
 * `workspaceRegistry` domain (L2) — `IWorkspaceQueryService` implementation.
 *
 * Answers workspace-centric read queries by composing the persisted session
 * index (`sessionIndex`); the recent-sessions list is delegated to
 * `sessionIndex` with the capped `RECENT_SESSIONS_LIMIT`. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';

import { IWorkspaceQueryService, RECENT_SESSIONS_LIMIT } from './workspaceQuery';

export class WorkspaceQueryService implements IWorkspaceQueryService {
  declare readonly _serviceBrand: undefined;

  constructor(@ISessionIndex private readonly index: ISessionIndex) {}

  async listRecentSessions(workspaceId: string): Promise<readonly SessionSummary[]> {
    const page = await this.index.list({ workspaceIds: [workspaceId], limit: RECENT_SESSIONS_LIMIT });
    return page.items;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceQueryService,
  WorkspaceQueryService,
  InstantiationType.Eager,
  'workspaceRegistry',
);
