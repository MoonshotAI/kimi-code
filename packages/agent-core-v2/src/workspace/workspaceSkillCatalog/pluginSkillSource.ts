/**
 * `workspaceSkillCatalog` domain — plugin `ISkillSource` producer.
 *
 * Discovers skills contributed by enabled plugins through `ISkillDiscovery`
 * (roots from `plugin.pluginSkillRoots()`), contributing them at priority 5
 * (above builtin, below extra / user / workspace, so project, user and extra
 * skills win name collisions). Re-emits `plugin.onDidReload` as `onDidChange`
 * so the catalog re-pulls plugin skills when plugins reload. Plugins are a
 * reload-gated snapshot: install / enable / remove mutations and on-disk
 * edits under plugin roots deliberately do not refresh the catalog — they
 * take effect on the next explicit reload. Bound at Workspace scope so every
 * session of the handler shares one scan.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
  isSkillLoadAborted,
  PLUGIN_SKILL_SOURCE_ID,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from '#/app/skillCatalog/skillSource';
import { IPluginService } from '#/app/plugin/plugin';

export interface IPluginSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IPluginSkillSource: ServiceIdentifier<IPluginSkillSource> =
  createDecorator<IPluginSkillSource>('pluginSkillSource');

export { PLUGIN_SKILL_SOURCE_ID };

export class PluginSkillSource extends Disposable implements IPluginSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = PLUGIN_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.plugin;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IPluginService private readonly plugins: IPluginService,
  ) {
    super();
    this._register(
      this.plugins.onDidReload(() => {
        this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(signal?: AbortSignal): Promise<SkillContribution> {
    const roots = await this.plugins.pluginSkillRoots();
    if (isSkillLoadAborted(signal)) return { skills: [] };
    return this.discovery.discover(roots, signal);
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IPluginSkillSource,
  PluginSkillSource,
  ScopeActivation.OnScopeCreated,
  'workspaceSkillCatalog',
);
