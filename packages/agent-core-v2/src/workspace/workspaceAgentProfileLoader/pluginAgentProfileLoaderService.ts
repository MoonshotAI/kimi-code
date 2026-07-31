/**
 * `workspaceAgentProfileLoader` domain — `IPluginAgentProfileLoader` implementation.
 *
 * Discovers agent profiles contributed by enabled plugins (roots from the
 * App-scope `plugins.pluginAgentRoots()`) and registers them via the shared
 * loader skeleton. Reloads when plugins reload; install / enable / remove
 * mutations deliberately do not re-register — those take effect on the next
 * explicit reload. Bound at Workspace scope: agent-file discovery lives in
 * the workspace layer alongside every other source.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from './internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { IUserAgentProfileLoader } from './userAgentProfileLoader';
import { IPluginAgentProfileLoader } from './pluginAgentProfileLoader';

export class PluginAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IPluginAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'plugin';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.plugin;

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IAgentProfileRegistry registry: IAgentProfileRegistry,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
  ) {
    super(registry, log);
    this._register(
      this.plugins.onDidReload(() => {
        void this.reload().catch((error) => {
          this.log.warn(`agent profile loader "plugin" reload failed: ${String(error)}`);
        });
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    const roots = await this.plugins.pluginAgentRoots();
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => {
        this.log.warn(message);
      }),
      (context) => this.user.getDefaultProfile().systemPrompt(context),
    );
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IPluginAgentProfileLoader,
  PluginAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileLoader',
);
