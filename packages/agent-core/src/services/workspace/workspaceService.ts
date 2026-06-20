import { Disposable, InstantiationType, registerSingleton } from '../../di';

import type {
  FsBrowseResponse,
  FsHomeResponse,
  Workspace,
} from '@moonshot-ai/protocol';

import { IWorkspaceService } from './workspace';
import { IWorkspaceFsService, RECENT_ROOTS_LIMIT } from './workspaceFs';
import { IWorkspaceRegistry, type WorkspacePatch } from './workspaceRegistry';

/**
 * Unified workspace facade — see {@link IWorkspaceService}.
 *
 * Delegates every method to the injected {@link IWorkspaceRegistry} (registry
 * + root resolution + recent) and {@link IWorkspaceFsService} (browse + home).
 * Holds no workspace state of its own and performs no filesystem access beyond
 * what the delegated services already do.
 */
export class WorkspaceService extends Disposable implements IWorkspaceService {
  readonly _serviceBrand: undefined;

  constructor(
    @IWorkspaceRegistry private readonly registry: IWorkspaceRegistry,
    @IWorkspaceFsService private readonly fs: IWorkspaceFsService,
  ) {
    super();
  }

  list(): Promise<Workspace[]> {
    return this.registry.list();
  }

  get(workspaceId: string): Promise<Workspace> {
    return this.registry.get(workspaceId);
  }

  createOrTouch(root: string, name?: string): Promise<Workspace> {
    return this.registry.createOrTouch(root, name);
  }

  update(workspaceId: string, patch: WorkspacePatch): Promise<Workspace> {
    return this.registry.update(workspaceId, patch);
  }

  delete(workspaceId: string): Promise<void> {
    return this.registry.delete(workspaceId);
  }

  resolveRoot(workspaceId: string): Promise<string> {
    return this.registry.resolveRoot(workspaceId);
  }

  async listRecent(): Promise<Workspace[]> {
    const all = await this.registry.list();
    return all.slice(0, RECENT_ROOTS_LIMIT);
  }

  browse(absPath?: string): Promise<FsBrowseResponse> {
    return this.fs.browse(absPath);
  }

  home(): Promise<FsHomeResponse> {
    return this.fs.home();
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    super.dispose();
  }
}

registerSingleton(IWorkspaceService, WorkspaceService, InstantiationType.Delayed);
