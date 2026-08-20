import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import { ISkillDiscovery } from '#/app/skillCatalog/skillDiscovery';
import {
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

export class PluginSkillSource implements IPluginSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = PLUGIN_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.plugin;
  readonly onDidChange: Event<void> = (listener, thisArg, disposables) =>
    this.plugins.onDidReload(
      () => listener.call(thisArg, undefined as void),
      undefined,
      disposables,
    );

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IPluginService private readonly plugins: IPluginService,
  ) {}

  async load(): Promise<SkillContribution> {
    return this.discovery.discover(await this.plugins.pluginSkillRoots());
  }
}

