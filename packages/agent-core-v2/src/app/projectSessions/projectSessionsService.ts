import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { sameDir } from '#/_base/utils/workdir-slug';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IProjectService } from '#/app/project/project';
import { IProjectAliases } from '#/app/projectAliases/projectAliases';
import type { Page } from '#/persistence/interface/queryStore';
import { sessionWorkDir } from '#/session/workdirContext/workdirRoots';

import { IProjectSessions, RECENT_SESSIONS_LIMIT, type WorkdirSessionQuery } from './projectSessions';

const WORKDIR_SCAN_PAGE_SIZE = 100;

export class ProjectSessionsService implements IProjectSessions {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProjectAliases private readonly aliases: IProjectAliases,
    @ISessionIndex private readonly index: ISessionIndex,
    @IProjectService private readonly projects: IProjectService,
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
    const decision = await this.projects.peekImplicit(dir);
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
  IProjectSessions,
  ProjectSessionsService,
  ScopeActivation.OnScopeCreated,
  'workspaceSessions',
);
