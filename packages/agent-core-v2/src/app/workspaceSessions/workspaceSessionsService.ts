/**
 * `workspaceSessions` domain — `IWorkspaceSessions` implementation.
 *
 * Answers workspace-centric read queries by composing the alias resolver
 * (`workspaceAliases`) with the persisted session index (`sessionIndex`):
 * every query expands the workspace id to its full alias set first, so legacy
 * split buckets count once for the workspace, not per bucket. The
 * recent-sessions list is capped at `RECENT_SESSIONS_LIMIT`; the count covers
 * archived sessions too. Bound at App scope.
 */

import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceAliases } from '#/app/workspaceAliases/workspaceAliases';

import { IWorkspaceSessions, RECENT_SESSIONS_LIMIT } from './workspaceSessions';

export class WorkspaceSessionsService implements IWorkspaceSessions {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceAliases private readonly aliases: IWorkspaceAliases,
    @ISessionIndex private readonly index: ISessionIndex,
  ) {}

  async listRecent(workspaceId: string): Promise<readonly SessionSummary[]> {
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    const page = await this.index.listRecent({ workspaceIds, limit: RECENT_SESSIONS_LIMIT });
    return page.items;
  }

  async count(workspaceId: string): Promise<number> {
    // One set-query over the alias set (legacy split buckets): a single merged
    // count cannot double-count, and a singleton set behaves exactly as
    // before.
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    return this.index.count({ workspaceIds, includeArchived: true });
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceSessions,
  WorkspaceSessionsService,
  ScopeActivation.OnScopeCreated,
  'workspaceSessions',
);
