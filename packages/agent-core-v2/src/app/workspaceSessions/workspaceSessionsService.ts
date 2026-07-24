/**
 * `workspaceSessions` domain (L2) — `IWorkspaceSessions` implementation.
 *
 * Answers workspace-centric read queries by composing the alias resolver
 * (`workspaceAliases`) with the persisted session index (`sessionIndex`):
 * every query expands the workspace id to its full alias set first, so legacy
 * split buckets count once for the workspace, not per bucket. The
 * recent-sessions list is capped at `RECENT_SESSIONS_LIMIT`; the count covers
 * archived sessions too. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
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
    const page = await this.index.list({ workspaceIds, limit: RECENT_SESSIONS_LIMIT });
    return page.items;
  }

  async count(workspaceId: string): Promise<number> {
    // One set-query over the alias set (legacy split buckets): a single merged
    // listing cannot double-count, and a singleton set behaves exactly as
    // before.
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    const page = await this.index.list({ workspaceIds, includeArchived: true });
    return page.items.length;
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceSessions,
  WorkspaceSessionsService,
  InstantiationType.Eager,
  'workspaceSessions',
);
