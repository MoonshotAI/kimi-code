import { ILogService } from '#/_base/log/log';
import { discoverAgentFiles } from '#/project/projectAgentProfileLoader/internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from '#/project/projectAgentProfileLoader/internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { configuredAgentRoots } from '#/project/projectAgentProfileLoader/internal/agentRoots';
import {
  EXTRA_AGENT_DIRS_SECTION,
  type ExtraAgentDirsConfig,
} from '#/project/projectAgentProfileLoader/configSection';
import { IUserAgentProfileLoader } from '#/project/projectAgentProfileLoader/userAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';

import { IExtraAgentProfileLoader } from './extraAgentProfileLoader';

export class ExtraAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IExtraAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'extra';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.extra;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IProjectContext private readonly project: IProjectContext,
    @IProjectDirs private readonly dirs: IProjectDirs,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this._register(
      this.configService.onDidSectionChange((event) => {
        if (event.domain === EXTRA_AGENT_DIRS_SECTION) {
          void this.reload().catch((error) => {
            this.log.warn(`agent profile loader "extra" reload failed: ${String(error)}`);
          });
        }
      }),
    );
    this._register(
      this.dirs.onDidChange(() => {
        void this.reload().catch((error) => {
          this.log.warn(`agent profile loader "extra" primary reload failed: ${String(error)}`);
        });
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.project.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.configService.ready;
    const dirs = this.configService.get<ExtraAgentDirsConfig>(EXTRA_AGENT_DIRS_SECTION) ?? [];
    return profilesFromDiscovery(
      await discoverAgentFiles(
        this.fs,
        await configuredAgentRoots(
          this.fs,
          dirs,
          this.dirs.primary,
          this.bootstrap.osHomeDir,
          'extra',
          (message, error) => {
            this.log.warn(message, error);
          },
        ),
        (message) => this.log.warn(message),
      ),
      (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
    );
  }
}

