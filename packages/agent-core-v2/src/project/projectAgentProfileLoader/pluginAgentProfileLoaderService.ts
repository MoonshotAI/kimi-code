import { ILogService } from '#/_base/log/log';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IProjectContext } from '#/project/projectContext/projectContext';

import { discoverAgentFiles } from './internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from './internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
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
    @IProjectContext private readonly project: IProjectContext,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
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
    return this.project.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    const roots = await this.plugins.pluginAgentRoots();
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => {
        this.log.warn(message);
      }),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
    );
  }
}

