import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { sameDir } from '#/_base/utils/workdir-slug';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { IWorkspaceAliases } from '#/app/workspaceAliases/workspaceAliases';
import type { Page } from '#/persistence/interface/queryStore';
import { sessionWorkDir } from '#/session/workspaceContext/workspaceRoots';

import { IWorkspaceSessions, RECENT_SESSIONS_LIMIT, type WorkdirSessionQuery } from './workspaceSessions';

const WORKDIR_SCAN_PAGE_SIZE = 100;

export class WorkspaceSessionsService implements IWorkspaceSessions {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceAliases private readonly aliases: IWorkspaceAliases,
    @ISessionIndex private readonly index: ISessionIndex,
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
  ) {}

  async listRecent(workspaceId: string): Promise<readonly SessionSummary[]> {
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    const page = await this.index.listRecent({ workspaceIds, limit: RECENT_SESSIONS_LIMIT });
    return page.items;
  }

  async count(workspaceId: string): Promise<number> {
    const workspaceIds = await this.aliases.resolveAliasIds(workspaceId);
    return this.index.count({ workspaceIds, includeArchived: true });
  }

  async listForWorkdir(dir: string, query: WorkdirSessionQuery = {}): Promise<Page<SessionSummary>> {
    const decision = await this.workspaces.peekImplicit(dir);
    const project = decision.kind === 'reuse' ? decision.project : decision;
    const workspaceIds = await this.aliases.resolveAliasIds(project.id);
    const items: SessionSummary[] = [];
    let before = query.before;
    for (;;) {
      const page = await this.index.listRecent({
        workspaceIds,
        includeArchived: query.includeArchived,
        before,
        limit: query.limit === undefined ? undefined : WORKDIR_SCAN_PAGE_SIZE,
      });
      for (const summary of page.items) {
        if (!sameDir(sessionWorkDir(summary, project.root), dir)) continue;
        items.push(summary);
        if (items.length === query.limit) return { items, nextCursor: summary.id };
      }
      if (page.nextCursor === undefined) return { items };
      before = page.nextCursor;
    }
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceSessions,
  WorkspaceSessionsService,
  ScopeActivation.OnScopeCreated,
  'workspaceSessions',
);
