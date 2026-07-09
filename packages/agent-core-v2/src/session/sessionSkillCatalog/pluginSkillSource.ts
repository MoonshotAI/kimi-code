/**
 * `sessionSkillCatalog` domain (L3) — plugin `ISkillSource` producer.
 *
 * Discovers skills contributed by enabled plugins through `ISkillDiscovery`
 * (roots from `plugin.pluginSkillRoots()`), contributing them at priority 5
 * (above builtin, below extra / user / workspace, so project, user and extra skills win name
 * collisions). Re-emits
 * `plugin.onDidReload` as `onDidChange` so the sink re-pulls plugin skills when
 * plugins reload. Bound at Session scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import type { Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from '#/app/skillCatalog/skillSource';
import { IPluginService } from '#/app/plugin/plugin';

export interface IPluginSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IPluginSkillSource: ServiceIdentifier<IPluginSkillSource> =
  createDecorator<IPluginSkillSource>('pluginSkillSource');

export class PluginSkillSource implements IPluginSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'plugin';
  readonly priority = SKILL_SOURCE_PRIORITY.plugin;
  readonly onDidChange: Event<void> = (listener, thisArg, disposables) =>
    this.plugins.onDidReload(() => listener(undefined as void), thisArg, disposables);

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IPluginService private readonly plugins: IPluginService,
  ) {}

  async load(): Promise<SkillContribution> {
    return this.discovery.discover(await this.plugins.pluginSkillRoots());
  }
}

registerScopedService(
  LifecycleScope.Session,
  IPluginSkillSource,
  PluginSkillSource,
  InstantiationType.Delayed,
  'sessionSkillCatalog',
);
