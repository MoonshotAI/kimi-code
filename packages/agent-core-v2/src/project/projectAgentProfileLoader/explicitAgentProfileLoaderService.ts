import { ILogService } from '#/_base/log/log';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { parseAgentFileText } from '#/project/projectAgentProfileLoader/internal/agentFile';
import { AgentProfileLoaderBase } from '#/project/projectAgentProfileLoader/internal/agentProfileLoader';
import { agentProfileFromFile } from '#/project/projectAgentProfileLoader/internal/agentProfileFromFile';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { resolveAgentPath } from '#/project/projectAgentProfileLoader/internal/paths';
import { IUserAgentProfileLoader } from '#/project/projectAgentProfileLoader/userAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IProjectContext } from '#/project/projectContext/projectContext';
import { IProjectDirs } from '#/project/projectDirs/projectDirs';

import { IExplicitAgentProfileLoader } from './explicitAgentProfileLoader';

export class ExplicitAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IExplicitAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'explicit';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.explicit;
  protected override readonly fatal = true;

  constructor(
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
      this.dirs.onDidChange(() => {
        void this.reload().catch((error) => {
          this.log.warn(`agent profile loader "explicit" primary reload failed: ${String(error)}`);
        });
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.project.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    const files = this.bootstrap.args.agentFiles ?? [];
    const profiles: AgentProfile[] = [];
    for (const file of files) {
      const filePath = resolveAgentPath(file, this.dirs.primary, this.bootstrap.osHomeDir);
      const text = await this.fs.readText(filePath);
      profiles.push(
        agentProfileFromFile(
          parseAgentFileText({ path: filePath, source: 'explicit', text }),
          (context) => this.user.getDefaultProfile().renderSystemPrompt(context),
        ),
      );
    }
    return { profiles };
  }
}

