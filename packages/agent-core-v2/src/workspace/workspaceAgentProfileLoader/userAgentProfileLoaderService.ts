/**
 * `workspaceAgentProfileLoader` domain — `IUserAgentProfileLoader` implementation.
 *
 * Discovers user agent profiles through `bootstrap` home paths and `hostFs`,
 * reports skipped files through `log`, and appends the `<home>/SYSTEM.md`
 * prompt-override profile (synthesized against the builtin default from the
 * App builtin loader) after the scanned profiles so it wins same-name
 * collisions within this contribution. The user roots are global os
 * directories, but per-workspace registration keeps every contribution
 * flowing through the same workspace-tagged lane. Bound at Workspace scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBuiltinAgentProfileLoader } from '#/app/agentProfileCatalog/builtinAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from './internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { userAgentRoots } from './internal/agentRoots';
import { loadSystemMdProfile } from './internal/systemFile';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';

export class UserAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IUserAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'user';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.user;

  private defaultProfile: AgentProfile;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IBuiltinAgentProfileLoader private readonly builtin: IBuiltinAgentProfileLoader,
    @IAgentProfileRegistry registry: IAgentProfileRegistry,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
  ) {
    super(registry, log);
    this.defaultProfile = builtin.getDefault();
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  getDefaultProfile(): AgentProfile {
    return this.defaultProfile;
  }

  protected async load(): Promise<AgentProfileContribution> {
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
      (message, error) => {
        this.log.warn(message, error);
      },
    );
    const systemMd = await loadSystemMdProfile(
      this.fs,
      this.bootstrap.homeDir,
      this.builtin.getDefault(),
      (message) => this.log.warn(message),
    );
    this.defaultProfile = systemMd ?? this.builtin.getDefault();
    const contribution = profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
      (context) => this.defaultProfile.renderSystemPrompt(context),
    );
    if (systemMd === undefined) return contribution;
    return { ...contribution, profiles: [...contribution.profiles, systemMd] };
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IUserAgentProfileLoader,
  UserAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileLoader',
);
