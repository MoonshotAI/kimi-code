/**
 * `skillCatalog` domain (L3) — builtin `ISkillSource` producer.
 *
 * Yields the code-defined `BUILTIN_SKILLS` as the lowest-priority contribution
 * (`builtin`, priority 0) so extra / user / workspace / plugin skills override it on
 * name collision. Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import { BUILTIN_SKILLS } from './builtin/builtin';
import { SKILL_SOURCE_PRIORITY, type ISkillSource, type SkillContribution } from './skillSource';

export interface IBuiltinSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IBuiltinSkillSource: ServiceIdentifier<IBuiltinSkillSource> =
  createDecorator<IBuiltinSkillSource>('builtinSkillSource');

export class BuiltinSkillSource implements IBuiltinSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = 'builtin';
  readonly priority = SKILL_SOURCE_PRIORITY.builtin;

  async load(): Promise<SkillContribution> {
    return { skills: BUILTIN_SKILLS };
  }
}

registerScopedService(
  LifecycleScope.App,
  IBuiltinSkillSource,
  BuiltinSkillSource,
  InstantiationType.Delayed,
  'skillCatalog',
);
