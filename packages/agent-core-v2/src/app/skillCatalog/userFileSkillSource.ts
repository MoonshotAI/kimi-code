/**
 * `skillCatalog` domain (L3) — user/brand `ISkillSource` producer.
 *
 * Discovers user skills from the bootstrap home directories through
 * `ISkillDiscovery`, contributing them at priority 20 (above extra / plugin /
 * builtin, below workspace). Reads home paths from `bootstrap`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import {
  MERGE_ALL_AVAILABLE_SKILLS_SECTION,
  type MergeAllAvailableSkillsConfig,
} from './configSection';
import { ISkillCatalogRuntimeOptions } from './skillCatalogRuntimeOptions';
import { ISkillDiscovery } from './skillDiscovery';
import { userRoots } from './skillRoots';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from './skillSource';

export interface IUserFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IUserFileSkillSource: ServiceIdentifier<IUserFileSkillSource> =
  createDecorator<IUserFileSkillSource>('userFileSkillSource');

export class UserFileSkillSource extends Disposable implements IUserFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = SKILL_SOURCE_PRIORITY.user;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISkillCatalogRuntimeOptions private readonly runtimeOptions: ISkillCatalogRuntimeOptions,
  ) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === MERGE_ALL_AVAILABLE_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

  async load(): Promise<SkillContribution> {
    if ((this.runtimeOptions.explicitDirs?.length ?? 0) > 0) {
      return { skills: [] };
    }
    await this.config.ready;
    const mergeAllAvailableSkills =
      this.config.get<MergeAllAvailableSkillsConfig>(MERGE_ALL_AVAILABLE_SKILLS_SECTION) ?? true;
    return this.discovery.discover(
      await userRoots(this.bootstrap.homeDir, this.bootstrap.osHomeDir, { mergeAllAvailableSkills }),
    );
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileSkillSource,
  UserFileSkillSource,
  InstantiationType.Eager,
  'skillCatalog',
);
