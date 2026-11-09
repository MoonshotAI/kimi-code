import { DisposableStore } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { projectAgentRootCandidates, projectAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceDirs } from '#/workspace/workspaceDirs/workspaceDirs';
import { watchCandidates } from '#human/utils/watch';

import { IWorkspaceAgentProfileLoader } from './workspaceAgentProfileLoader';

const WATCH_DEBOUNCE_MS = 200;

export class WorkspaceAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IWorkspaceAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'workspace';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.workspace;

  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;
  private watchers?: DisposableStore;
  private watchedPrimary?: string;
  private primaryReloadTail: Promise<void> = Promise.resolve();

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IWorkspaceDirs private readonly dirs: IWorkspaceDirs,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    registry?: IAgentProfileRegistry,
    protected override readonly contextKey?: string,
    private readonly watchEnabled = true,
  ) {
    super(log, registry);
    this._register({ dispose: () => this.watchers?.dispose() });
    this.primaryReloadTail = this.refreshPrimary(false);
    this.watchReady = this.primaryReloadTail;
    this._register(
      this.dirs.onDidChange(() => {
        this.primaryReloadTail = this.primaryReloadTail.then(
          () => this.refreshPrimary(),
          () => this.refreshPrimary(),
        );
        void this.primaryReloadTail.catch((error) => {
          this.log.warn(`agent profile primary reload failed: ${String(error)}`);
        });
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.watchReady;
    const roots = await projectAgentRoots(this.fs, this.dirs.primary, (message, error) => {
      this.log.warn(message, error);
    });
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
    );
  }

  private async refreshPrimary(reload = true): Promise<void> {
    await this.dirs.ready;
    const primary = this.dirs.primary;
    if (this.watchedPrimary === primary) return;
    await this.refreshProjectAgentRoots();
    if (reload) await this.reload();
  }

  private async refreshProjectAgentRoots(): Promise<void> {
    const primary = this.dirs.primary;
    if (!this.watchEnabled || this.watchedPrimary === primary) return;
    const { projectRoot, candidates } = await projectAgentRootCandidates(
      this.fs,
      primary,
      (message, error) => this.log.warn(message, error),
    );
    const handle = watchCandidates(projectRoot, candidates, {
      ignored: subtreeWatchFilter(projectRoot, candidates),
    });
    const subscription = handle.onDidChange(() => {
      this.watchDebounce.cancelAndSet(() => {
        void this.reload().catch((error) => {
          this.log.warn(`agent profile loader "workspace" reload failed: ${String(error)}`);
        });
      }, WATCH_DEBOUNCE_MS);
    });
    this.watchers?.dispose();
    this.watchers = new DisposableStore();
    this.watchers.add(handle);
    this.watchers.add(subscription);
    this.watchedPrimary = primary;
  }
}
