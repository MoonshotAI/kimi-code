/**
 * `sessionAgentProfileCatalog` domain (L3) — plugin `IAgentProfileSource`
 * producer.
 *
 * Discovers agent profiles contributed by enabled plugins (roots from
 * `plugin.pluginAgentRoots()`), contributing them at priority 5 (above
 * builtin, below user / extra / project / explicit, so every other file
 * source wins name collisions). `${base_prompt}` is backed by the user
 * source's effective default profile. Re-emits `plugin.onDidReload` as
 * `onDidChange` so the catalog re-pulls plugin agents when plugins reload;
 * install / enable / remove mutations deliberately do not refresh the
 * session catalog — those take effect on the next explicit reload. Bound at
 * Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { discoverAgentFiles } from '#/app/agentFileCatalog/agentFileDiscovery';
import {
  AGENT_PROFILE_SOURCE_PRIORITY,
  profilesFromDiscovery,
  type AgentProfileContribution,
  type IAgentProfileSource,
} from '#/app/agentFileCatalog/agentProfileSource';
import { IUserFileAgentSource } from '#/app/agentFileCatalog/userFileAgentSource';
import { IPluginService } from '#/app/plugin/plugin';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';

export interface IPluginAgentProfileSource extends IAgentProfileSource {
  readonly _serviceBrand: undefined;
}

export const IPluginAgentProfileSource: ServiceIdentifier<IPluginAgentProfileSource> =
  createDecorator<IPluginAgentProfileSource>('pluginAgentProfileSource');

export class PluginAgentProfileSource implements IPluginAgentProfileSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'plugin';
  readonly priority = AGENT_PROFILE_SOURCE_PRIORITY.plugin;
  readonly onDidChange: Event<void> = (listener, thisArg, disposables) =>
    this.plugins.onDidReload(
      () => listener.call(thisArg, undefined as void),
      undefined,
      disposables,
    );

  constructor(
    @IPluginService private readonly plugins: IPluginService,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @ILogService private readonly log: ILogService,
    @IUserFileAgentSource private readonly user: IUserFileAgentSource,
  ) {}

  async load(): Promise<AgentProfileContribution> {
    const roots = await this.plugins.pluginAgentRoots();
    return profilesFromDiscovery(
      await discoverAgentFiles(this.fs, roots, (message) => {
        this.log.warn(message);
      }),
      (context) => this.user.getDefaultProfile().systemPrompt(context),
    );
  }
}

registerScopedService(
  LifecycleScope.Session,
  IPluginAgentProfileSource,
  PluginAgentProfileSource,
  ScopeActivation.OnScopeCreated,
  'sessionAgentProfileCatalog',
);
