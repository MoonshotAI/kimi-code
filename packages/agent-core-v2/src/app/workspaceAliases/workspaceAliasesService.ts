import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IWorkspaceService } from '#/app/workspace/workspace';
import {
  collectAliasIds,
  readSessionIndexEntries,
} from '#/app/workspace/workspaceAlias';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { IWorkspaceAliases } from './workspaceAliases';

export class WorkspaceAliasesService implements IWorkspaceAliases {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {}

  async resolveAliasIds(id: string): Promise<readonly string[]> {
    const entry = await this.workspaces.get(id);
    if (entry === undefined) return [id];
    const catalog = (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
    return collectAliasIds(
      catalog.workspaces,
      await readSessionIndexEntries(this.storage),
      entry.root,
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceAliases,
  WorkspaceAliasesService,
  ScopeActivation.OnScopeCreated,
  'workspaceAliases',
);
