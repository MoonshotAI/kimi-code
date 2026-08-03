/**
 * `workspaceAliases` domain (L2) — `IWorkspaceAliases` implementation.
 *
 * Resolves every id spelling of one physical directory by folding the
 * registered catalog (by `workspaceRootKey`) together with `workDir`
 * spellings recorded only in the legacy `session_index.jsonl`, through the
 * shared `workspaceAlias` helpers. The catalog is reached through
 * `IWorkspaceService.get` first — its once-per-process session-index sync
 * (`ensureMerged`) must have run before the raw catalog is read from
 * `IWorkspacePersistence` — and the raw (un-deduped) catalog is required
 * because `IWorkspaceService.list` collapses sibling spellings to one
 * representative, which would defeat the alias enumeration. Read-only: no id
 * or bucket is ever rewritten here. Bound at App scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
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
    // Goes through the workspace service so the once-per-process session-index
    // sync has run before the raw catalog is read below.
    const entry = await this.workspaces.get(id);
    // Unknown ids stay singletons so callers keep their not-found semantics.
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
  InstantiationType.Eager,
  'workspaceAliases',
);
