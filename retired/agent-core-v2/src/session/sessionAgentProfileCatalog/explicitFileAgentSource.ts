/**
 * `sessionAgentProfileCatalog` domain (L3) — explicit `IAgentProfileSource`
 * producer.
 *
 * Loads runtime-selected agent files through `hostFs`, resolving paths through
 * `workspace` and `bootstrap`. `${base_prompt}` is backed by the user source's
 * effective default profile. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentCatalogRuntimeOptions } from '#/app/agentFileCatalog/agentCatalogRuntimeOptions';
import { parseAgentFileText } from '#/app/agentFileCatalog/agentFile';
import { agentProfileFromFile } from '#/app/agentFileCatalog/agentProfileFromFile';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { resolveAgentPath } from '#/app/agentFileCatalog/paths';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

export interface IExplicitFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IExplicitFileAgentSource: ServiceIdentifier<IExplicitFileAgentSource> =
  createDecorator<IExplicitFileAgentSource>('explicitFileAgentSource');

export class ExplicitFileAgentSource implements IExplicitFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'explicit';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.explicit;
  readonly fatal = true;

  constructor(
    @IAgentCatalogRuntimeOptions private readonly runtimeOptions: IAgentCatalogRuntimeOptions,
    @ISessionWorkspaceContext private readonly workspace: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IUserFileAgentSource private readonly user: IUserFileAgentSource,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const files = this.runtimeOptions.explicitFiles ?? [];
    const profiles: AgentProfile[] = [];
    for (const file of files) {
      const filePath = resolveAgentPath(file, this.workspace.workDir, this.bootstrap.osHomeDir);
      const text = await this.fs.readText(filePath);
      profiles.push(
        agentProfileFromFile(parseAgentFileText({ path: filePath, source: 'explicit', text }), (context) =>
          this.user.getDefaultProfile().systemPrompt(context),
        ),
      );
    }
    return { profiles };
  }
}

registerScopedService(
  LifecycleScope.Session,
  IExplicitFileAgentSource,
  ExplicitFileAgentSource,
  InstantiationType.Eager,
  'sessionAgentProfileCatalog',
);
