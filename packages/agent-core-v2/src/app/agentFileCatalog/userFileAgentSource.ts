/**
 * `agentFileCatalog` domain (L3) — user `IAgentProfileSource` producer.
 *
 * Discovers user agent profiles through `bootstrap` home paths and `hostFs`,
 * and reports skipped files through `log`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
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
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const roots = await userAgentRoots(
      this.fs,
      this.bootstrap.homeDir,
      this.bootstrap.osHomeDir,
    );
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => this.log.warn(message)),
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileAgentSource,
  UserFileAgentSource,
  InstantiationType.Eager,
  'agentFileCatalog',
);
