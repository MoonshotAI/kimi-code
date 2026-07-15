/**
 * `sessionAgentProfileCatalog` domain (L3) — project `IAgentProfileSource`
 * producer.
 *
 * Discovers agent files from the session's current `workDir`
 * (`.kimi-code/agents`, `.agents/agents`, walking up to `.git`), contributing
 * them at priority 30 (above user / extra / builtin, below explicit). Bound at
 * Session scope so each session reads its own workspace root. Mirrors
 * `sessionSkillCatalog/workspaceFileSkillSource`.
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
    @ILogService private readonly log: ILogService,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const roots = await projectAgentRoots(this.workspace.workDir);
    return profilesFromDiscovery(
      await discoverAgentFiles(roots, (message) => this.log.warn(message)),
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
