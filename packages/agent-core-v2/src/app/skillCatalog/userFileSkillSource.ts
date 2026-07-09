/**
 * `skillCatalog` domain (L3) — user/brand `ISkillSource` producer.
 *
 * Discovers user skills from the bootstrap home directories through
 * `ISkillDiscovery`, contributing them at priority 10 (above builtin and
 * plugin, below workspace). Reads home paths from `bootstrap`. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';

import { ISkillDiscovery } from './skillDiscovery';
import { userRoots } from './skillRoots';
import type { ISkillSource, SkillContribution } from './skillSource';

export interface IUserFileSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IUserFileSkillSource: ServiceIdentifier<IUserFileSkillSource> =
  createDecorator<IUserFileSkillSource>('userFileSkillSource');

export class UserFileSkillSource implements IUserFileSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'user';
  readonly priority = 10;

  constructor(
    @ISkillDiscovery private readonly discovery: ISkillDiscovery,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {}

  async load(): Promise<SkillContribution> {
    return this.discovery.discover(await userRoots(this.bootstrap.homeDir, this.bootstrap.osHomeDir));
  }
}

registerScopedService(
  LifecycleScope.App,
  IUserFileSkillSource,
  UserFileSkillSource,
  InstantiationType.Delayed,
  'skillCatalog',
);
