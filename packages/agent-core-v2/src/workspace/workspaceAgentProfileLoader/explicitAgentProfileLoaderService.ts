import { ILogService } from '#/_base/log/log';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { parseAgentFileText } from '#/workspace/workspaceAgentProfileLoader/internal/agentFile';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import { agentProfileFromFile } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileFromFile';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import type { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { resolveAgentPath } from '#/workspace/workspaceAgentProfileLoader/internal/paths';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

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
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    registry?: IAgentProfileRegistry,
  ) {
    super(log, registry);
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    const files = this.bootstrap.args.agentFiles ?? [];
    const profiles: AgentProfile[] = [];
    for (const file of files) {
      const filePath = resolveAgentPath(file, this.workspace.cwd, this.bootstrap.osHomeDir);
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

