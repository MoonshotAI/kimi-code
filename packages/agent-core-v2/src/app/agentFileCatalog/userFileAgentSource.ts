/**
 * `agentFileCatalog` domain (L3) — user `IAgentProfileSource` producer.
 *
 * Discovers user agent profiles through `bootstrap` home paths and `hostFs`,
 * reports skipped files through `log`, and appends the `<home>/SYSTEM.md`
 * prompt-override profile (synthesized against the builtin default from the
 * App profile catalog) after the scanned profiles so it wins same-name
 * collisions within this contribution. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IAgentProfileCatalogService } from '#/app/agentProfileCatalog/agentProfileCatalog';
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
}

export const IUserFileAgentSource: ServiceIdentifier<IUserFileAgentSource> =
  createDecorator<IUserFileAgentSource>('userFileAgentSource');

export class UserFileAgentSource implements IUserFileAgentSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.user;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IAgentProfileCatalogService private readonly builtin: IAgentProfileCatalogService,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
    );
    const contribution = profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
    );
    const systemMd = await loadSystemMdProfile(
      this.fs,
      this.bootstrap.homeDir,
      this.builtin.getDefault(),
      (message) => this.log.warn(message),
    );
    if (systemMd === undefined) return contribution;
    // Append last: within one contribution a later same-name profile wins, so
    // SYSTEM.md beats a scanned `agents/agent.md` from the user directory.
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
