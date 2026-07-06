import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap';
import type { HookDef } from '#/agent/externalHooks/types';
import type { McpServerConfig } from '#/agent/mcp/config-schema';
import type { SkillRoot } from '#/app/skillCatalog/types';

import { PluginManager } from './manager';
import {
  type GetPluginInfoInput,
  type InstallPluginInput,
  IPluginService,
  type RemovePluginInput,
  type SetPluginEnabledInput,
  type SetPluginMcpServerEnabledInput,
} from './plugin';
import type {
  EnabledPluginSessionStart,
  PluginCommandDef,
  PluginInfo,
  PluginSummary,
  PluginUpdateStatus,
  ReloadSummary,
} from './types';

export class PluginService extends Disposable implements IPluginService {
  declare readonly _serviceBrand: undefined;

  private readonly manager: PluginManager;
  private loaded = false;
  private readonly onDidReloadEmitter = this._register(new Emitter<ReloadSummary>());

  readonly onDidReload: Event<ReloadSummary> = this.onDidReloadEmitter.event;

  constructor(@IBootstrapService bootstrap: IBootstrapService) {
    super();
    this.manager = new PluginManager({ kimiHomeDir: bootstrap.homeDir });
  }

  async listPlugins(): Promise<readonly PluginSummary[]> {
    await this.ensureLoaded();
    return this.manager.summaries();
  }

  async installPlugin(input: InstallPluginInput): Promise<PluginSummary> {
    await this.ensureLoaded();
    const record = await this.manager.install(input.source);
    return this.manager.info(record.id) as PluginSummary;
  }

  async setPluginEnabled(input: SetPluginEnabledInput): Promise<void> {
    await this.ensureLoaded();
    await this.manager.setEnabled(input.id, input.enabled);
  }

  async setPluginMcpServerEnabled(input: SetPluginMcpServerEnabledInput): Promise<void> {
    await this.ensureLoaded();
    await this.manager.setMcpServerEnabled(input.id, input.server, input.enabled);
  }

  async removePlugin(input: RemovePluginInput): Promise<void> {
    await this.ensureLoaded();
    await this.manager.remove(input.id);
  }

  async reloadPlugins(): Promise<ReloadSummary> {
    const summary = await this.manager.reload();
    this.loaded = true;
    this.onDidReloadEmitter.fire(summary);
    return summary;
  }

  async getPluginInfo(input: GetPluginInfoInput): Promise<PluginInfo | undefined> {
    await this.ensureLoaded();
    return this.manager.info(input.id);
  }

  async listPluginCommands(): Promise<readonly PluginCommandDef[]> {
    await this.ensureLoaded();
    return this.manager.enabledCommands();
  }

  async checkUpdates(): Promise<readonly PluginUpdateStatus[]> {
    await this.ensureLoaded();
    return this.manager.checkUpdates();
  }

  async pluginSkillRoots(): Promise<readonly SkillRoot[]> {
    await this.ensureLoaded();
    return this.manager.pluginSkillRoots();
  }

  async enabledSessionStarts(): Promise<readonly EnabledPluginSessionStart[]> {
    await this.ensureLoaded();
    return this.manager.enabledSessionStarts();
  }

  async enabledMcpServers(): Promise<Record<string, McpServerConfig>> {
    await this.ensureLoaded();
    return this.manager.enabledMcpServers();
  }

  async enabledHooks(): Promise<readonly HookDef[]> {
    await this.ensureLoaded();
    return this.manager.enabledHooks();
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await this.manager.load();
    this.loaded = true;
  }
}

registerScopedService(
  LifecycleScope.App,
  IPluginService,
  PluginService,
  InstantiationType.Delayed,
  'plugin',
);
