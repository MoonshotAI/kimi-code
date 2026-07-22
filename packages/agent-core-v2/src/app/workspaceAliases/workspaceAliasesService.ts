/**
 * `workspaceAliases` domain (L2) — `IWorkspaceAliases` implementation.
 *
 * Resolves every id spelling of one physical directory by folding the
 * registered catalog (by `workspaceRootKey`) together with `workDir`
 * spellings recorded only in the legacy v1 session index, through
 * `ILegacySessionIndexStore` and the pure `workspaceAlias` helpers. The
 * catalog is reached through `IWorkspaceService.get` first: its
 * once-per-process session-index sync (`ensureMerged`) must have run before
 * the raw catalog is read from `IWorkspacePersistence`. The raw, un-deduped
 * catalog is required because `IWorkspaceService.list` collapses sibling
 * spellings to one representative, which would defeat alias enumeration.
 * Read-only; bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILegacySessionIndexStore } from '#/app/sessionIndex/legacySessionIndexStore';
import { IWorkspaceService } from '#/app/workspace/workspace';
import { collectAliasIds } from '#/app/workspace/workspaceAlias';
import { IWorkspacePersistence } from '#/app/workspace/workspacePersistence';

import { IWorkspaceAliases } from './workspaceAliases';

export class WorkspaceAliasesService implements IWorkspaceAliases {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceService private readonly workspaces: IWorkspaceService,
    @IWorkspacePersistence private readonly store: IWorkspacePersistence,
    @ILegacySessionIndexStore private readonly legacySessionIndex: ILegacySessionIndexStore,
  ) {}

  async resolveAliasIds(id: string): Promise<readonly string[]> {
    const entry = await this.workspaces.get(id);
    if (entry === undefined) return [id];
    const catalog = (await this.store.load()) ?? { workspaces: [], deletedIds: [] };
    return collectAliasIds(
      catalog.workspaces,
      await this.legacySessionIndex.readEntries(),
      entry.root,
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceAliases,
  WorkspaceAliasesService,
  InstantiationType.Eager,
  'workspaceAliases',
);
