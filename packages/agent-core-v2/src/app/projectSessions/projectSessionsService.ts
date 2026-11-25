import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { isWorkDirKey, sameDir } from '#/_base/utils/workdir-slug';
import { ISessionIndex, type SessionSummary } from '#/app/sessionIndex/sessionIndex';
import { IProjectService } from '#/app/project/project';
import { IProjectAliases } from '#/app/projectAliases/projectAliases';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { isHostFsNotDirectory, isHostFsNotFound } from '#/os/interface/hostFsErrors';
import type { Page } from '#/persistence/interface/queryStore';

import { IProjectSessions, RECENT_SESSIONS_LIMIT, type WorkdirSessionQuery } from './projectSessions';

const WORKDIR_SCAN_PAGE_SIZE = 100;

export class ProjectSessionsService implements IProjectSessions {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IProjectAliases private readonly aliases: IProjectAliases,
    @ISessionIndex private readonly index: ISessionIndex,
    @IProjectService private readonly projects: IProjectService,
    @IHostFileSystem private readonly hostFs: IHostFileSystem,
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
    if (query.limit !== undefined && query.limit <= 0) return { items: [] };
    const workspaceIds = await this.implicitWorkspaceIds(dir);
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
        if (!isWorkDirKey(summary.workspaceId) || !ranIn(summary, dir)) continue;
        items.push(summary);
        if (items.length === query.limit) return { items, nextCursor: summary.id };
      }
      if (page.nextCursor === undefined) return { items };
      before = page.nextCursor;
    }
  }

  async listForProject(dir: string, query: WorkdirSessionQuery = {}): Promise<Page<SessionSummary>> {
    if (query.limit !== undefined && query.limit <= 0) return { items: [] };
    const workspaceIds = await this.implicitWorkspaceIds(dir);
    if (workspaceIds === undefined) return { items: [] };
    return this.index.listRecent({
      workspaceIds,
      includeArchived: query.includeArchived,
      limit: query.limit,
      before: query.before,
    });
  }

  private async implicitWorkspaceIds(dir: string): Promise<readonly string[] | undefined> {
    if (await this.isMissing(dir)) return undefined;
    const project = await this.projects.peekImplicit(dir);
    return this.aliases.resolveAliasIds(project.id);
  }

  private async isMissing(dir: string): Promise<boolean> {
    try {
      await this.hostFs.stat(dir);
      return false;
    } catch (error) {
      return isHostFsNotFound(error) || isHostFsNotDirectory(error);
    }
  }
}

function ranIn(summary: SessionSummary, dir: string): boolean {
  return summary.cwd !== undefined && sameDir(summary.cwd, dir);
}

registerScopedService(
  LifecycleScope.App,
  IProjectSessions,
  ProjectSessionsService,
  ScopeActivation.OnScopeCreated,
  'workspaceSessions',
);
