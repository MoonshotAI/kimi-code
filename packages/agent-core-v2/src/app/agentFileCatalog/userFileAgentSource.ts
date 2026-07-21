/**
 * `agentFileCatalog` domain (L3) — user `IAgentProfileSource` producer.
 *
 * Discovers user agent profiles through `bootstrap` home paths and `hostFs`,
 * reports skipped files through `log`, and appends the `<home>/SYSTEM.md`
 * prompt-override profile (synthesized against the builtin default from the
 * App profile catalog) after the scanned profiles so it wins same-name
 * collisions within this contribution. Also exposes the effective default
 * profile — the `SYSTEM.md` override when present, else the builtin default,
 * refreshed on each `load()` pass — so every agent-file source can back
 * `${base_prompt}` with it. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import {
  IAgentProfileCatalogService,
  type AgentProfile,
} from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

import { discoverAgentFiles } from './agentFileDiscovery';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  profilesFromDiscovery,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from './agentProfileSource';
import { userAgentRoots } from './agentRoots';
import { loadSystemMdProfile } from './systemFile';

export interface IUserFileAgentSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
  getDefaultProfile(): AgentProfile;
}

export const IUserFileAgentSource: ServiceIdentifier<IUserFileAgentSource> =
  createDecorator<IUserFileAgentSource>('userFileAgentSource');

export class UserFileAgentSource implements IUserFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.user;

  private defaultProfile: AgentProfile;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IAgentProfileCatalogService private readonly builtin: IAgentProfileCatalogService,
  ) {
    this.defaultProfile = builtin.getDefault();
  }

  getDefaultProfile(): AgentProfile {
    return this.defaultProfile;
  }

  async load(): Promise<AgentProfileContribution> {
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
      (message, error) => {
        this.log.warn(message, error);
      },
    );
    const systemMd = await loadSystemMdProfile(
      this.fs,
      this.bootstrap.homeDir,
      this.builtin.getDefault(),
      (message) => this.log.warn(message),
    );
    this.defaultProfile = systemMd ?? this.builtin.getDefault();
    const contribution = profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
      (context) => this.defaultProfile.systemPrompt(context),
    );
    if (systemMd === undefined) return contribution;
    return { ...contribution, profiles: [...contribution.profiles, systemMd] };
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileAgentSource,
  UserFileAgentSource,
  InstantiationType.Eager,
  'agentFileCatalog',
);
