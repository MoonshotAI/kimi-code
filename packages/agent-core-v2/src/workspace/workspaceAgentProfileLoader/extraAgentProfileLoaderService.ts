/**
 * `workspaceAgentProfileLoader` domain (L3) — `IExtraAgentProfileLoader` implementation.
 *
 * Resolves the configured `extraAgentDirs` through `config`, `workspaceContext`,
 * `bootstrap`, and `hostFs`, reporting skipped files through `log`.
 * `${base_prompt}` is backed by the user loader's effective default profile.
 * Reloads when the `extraAgentDirs` config section changes. Bound at
 * Workspace scope.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { discoverAgentFiles } from '#/workspace/workspaceAgentProfileLoader/internal/agentFileDiscovery';
import { AgentProfileLoaderBase } from '#/workspace/workspaceAgentProfileLoader/internal/agentProfileLoader';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  type AgentProfileContribution,
} from '#/app/agentProfileCatalog/agentProfileContribution';
import { profilesFromDiscovery } from './internal/agentProfileFromFile';
import { configuredAgentRoots } from '#/workspace/workspaceAgentProfileLoader/internal/agentRoots';
import {
  EXTRA_AGENT_DIRS_SECTION,
  type ExtraAgentDirsConfig,
} from '#/workspace/workspaceAgentProfileLoader/configSection';
import { IUserAgentProfileLoader } from '#/workspace/workspaceAgentProfileLoader/userAgentProfileLoader';
import { IAgentProfileRegistry } from '#/app/agentProfileCatalog/agentProfileRegistry';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

import { IExtraAgentProfileLoader } from './extraAgentProfileLoader';

export class ExtraAgentProfileLoaderService
  extends AgentProfileLoaderBase
  implements IExtraAgentProfileLoader
{
  declare readonly _serviceBrand: undefined;

  protected readonly sourceId = 'extra';
  protected readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.extra;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService log: ILogService,
    @IUserAgentProfileLoader private readonly user: IUserAgentProfileLoader,
    @IAgentProfileRegistry registry: IAgentProfileRegistry,
  ) {
    super(registry, log);
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === EXTRA_AGENT_DIRS_SECTION) {
          void this.reload().catch((error) => {
            this.log.warn(`agent profile loader "extra" reload failed: ${String(error)}`);
          });
        }
      }),
    );
    this.start();
  }

  protected override get workspaceKey(): string {
    return this.workspace.workspaceId;
  }

  protected async load(): Promise<AgentProfileContribution> {
    await this.config.ready;
    const dirs = this.config.get<ExtraAgentDirsConfig>(EXTRA_AGENT_DIRS_SECTION) ?? [];
    return profilesFromDiscovery(
      await discoverAgentFiles(
        this.fs,
        await configuredAgentRoots(
          this.fs,
          dirs,
          this.workspace.cwd,
          this.bootstrap.osHomeDir,
          'extra',
          (message, error) => {
            this.log.warn(message, error);
          },
        ),
        (message) => this.log.warn(message),
      ),
      (context) => this.user.getDefaultProfile().systemPrompt(context),
    );
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IExtraAgentProfileLoader,
  ExtraAgentProfileLoaderService,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileLoader',
);
