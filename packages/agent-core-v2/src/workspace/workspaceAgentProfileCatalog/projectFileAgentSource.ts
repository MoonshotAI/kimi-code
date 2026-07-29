/**
 * `workspaceAgentProfileCatalog` domain (L3) — project `IAgentProfileSource`
 * producer.
 *
 * Discovers project agent profiles from the handler's workspace root through
 * `workspaceContext` and `hostFs`, and reports skipped files through `log`.
 * `${base_prompt}` is backed by the user source's effective default profile.
 * Watches the project agent-root candidates (`.kimi-code/agents`,
 * `.agents/agents` under the project root, watched whether or not they exist
 * yet) through `hostFsWatch` and re-fires `onDidChange` debounced, so the
 * catalog re-scans THIS source only when project agent files change. Bound
 * at Workspace scope so every session of the handler shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { TimeoutTimer } from '#/_base/utils/timer';
import { subtreeWatchFilter } from '#/_base/utils/paths';
import { discoverAgentFiles } from '#/app/agentFileCatalog/agentFileDiscovery';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  profilesFromDiscovery,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { projectAgentRootCandidates, projectAgentRoots } from '#/app/agentFileCatalog/agentRoots';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostFsWatchService } from '#/os/interface/hostFsWatch';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

const WATCH_DEBOUNCE_MS = 200;

export interface IProjectFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IProjectFileAgentSource: ServiceIdentifier<IProjectFileAgentSource> =
  createDecorator<IProjectFileAgentSource>('projectFileAgentSource');

export class ProjectFileAgentSource extends Disposable implements IProjectFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'project';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.project;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;
  private readonly watchDebounce = this._register(new TimeoutTimer());
  private readonly watchReady: Promise<void>;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IUserFileAgentSource private readonly user: IUserFileAgentSource,
    @IHostFsWatchService private readonly fsWatch: IHostFsWatchService,
  ) {
    super();
    this.watchReady = this.watchProjectAgentRoots();
  }

  async load(): Promise<AgentProfileContribution> {
    // The watch attaches before the first scan returns, so a change landing
    // right after the scan cannot slip between the two.
    await this.watchReady;
    const roots = await projectAgentRoots(this.fs, this.workspace.cwd, (message, error) => {
      this.log.warn(message, error);
    });
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
      (context) => this.user.getDefaultProfile().systemPrompt(context),
    );
  }

  private async watchProjectAgentRoots(): Promise<void> {
    // Watch the project root recursively, pruned to the agent-root
    // candidates: watching a candidate directory directly never fires when
    // its parent (`.kimi-code` / `.agents`) does not exist yet either.
    const { projectRoot, candidates } = await projectAgentRootCandidates(
      this.fs,
      this.workspace.cwd,
      (message) => this.log.warn(message),
    );
    const handle = this.fsWatch.watch(projectRoot, {
      ignored: subtreeWatchFilter(projectRoot, candidates),
    });
    this._register(handle);
    this._register(
      handle.onDidChange(() => {
        this.watchDebounce.cancelAndSet(() => this.onDidChangeEmitter.fire(), WATCH_DEBOUNCE_MS);
      }),
    );
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IProjectFileAgentSource,
  ProjectFileAgentSource,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileCatalog',
);
