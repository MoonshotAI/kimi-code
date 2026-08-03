/**
 * `sessionAgentProfileCatalog` domain (L3) — project `IAgentProfileSource`
 * producer.
 *
 * Discovers project agent profiles through `workspace` and `hostFs`, and
 * reports skipped files through `log`. `${base_prompt}` is backed by the user
 * source's effective default profile. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { discoverAgentFiles } from '#/app/agentFileCatalog/agentFileDiscovery';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  profilesFromDiscovery,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { projectAgentRoots } from '#/app/agentFileCatalog/agentRoots';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IProjectFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IProjectFileAgentSource: ServiceIdentifier<IProjectFileAgentSource> =
  createDecorator<IProjectFileAgentSource>('projectFileAgentSource');

export class ProjectFileAgentSource implements IProjectFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'project';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.project;

  constructor(
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IUserFileAgentSource private readonly user: IUserFileAgentSource,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const roots = await projectAgentRoots(
      this.fs,
      this.workspace.workDir,
      (message, error) => {
        this.log.warn(message, error);
      },
    );
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
      (context) => this.user.getDefaultProfile().systemPrompt(context),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  IProjectFileAgentSource,
  ProjectFileAgentSource,
  InstantiationType.Eager,
  'sessionAgentProfileCatalog',
);
