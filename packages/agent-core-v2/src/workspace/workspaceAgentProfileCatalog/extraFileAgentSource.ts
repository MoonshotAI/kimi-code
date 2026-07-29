/**
 * `workspaceAgentProfileCatalog` domain (L3) — extra `IAgentProfileSource`
 * producer.
 *
 * Discovers configured agent profiles through `config`, `workspaceContext`,
 * `bootstrap`, and `hostFs`, resolving relative paths against the workspace
 * root, and reports skipped files through `log`. `${base_prompt}` is backed
 * by the user source's effective default profile. Re-fires `onDidChange`
 * when the `extraAgentDirs` config section changes so the catalog re-scans
 * THIS source only. Bound at Workspace scope so every session of the handler
 * shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { discoverAgentFiles } from '#/app/agentFileCatalog/agentFileDiscovery';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  profilesFromDiscovery,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { configuredAgentRoots } from '#/app/agentFileCatalog/agentRoots';
import {
  EXTRA_AGENT_DIRS_SECTION,
  type ExtraAgentDirsConfig,
} from '#/app/agentFileCatalog/configSection';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';

export interface IExtraFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IExtraFileAgentSource: ServiceIdentifier<IExtraFileAgentSource> =
  createDecorator<IExtraFileAgentSource>('extraFileAgentSource');

export class ExtraFileAgentSource extends Disposable implements IExtraFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'extra';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.extra;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(
    @IConfigService private readonly config: IConfigService,
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IUserFileAgentSource private readonly user: IUserFileAgentSource,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === EXTRA_AGENT_DIRS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(): Promise<AgentProfileContribution> {
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
  IExtraFileAgentSource,
  ExtraFileAgentSource,
  ScopeActivation.OnScopeCreated,
  'workspaceAgentProfileCatalog',
);
