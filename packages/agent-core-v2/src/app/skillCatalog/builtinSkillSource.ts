/**
 * `skillCatalog` domain — builtin `ISkillSource` producer.
 *
 * Yields the code-defined `BUILTIN_SKILLS` as the lowest-priority contribution
 * (`builtin`, priority 0) so extra / user / workspace / plugin skills override it on
 * name collision. Bound at App scope.
 *
 * This is also where product-documentation skills are filtered out when
 * `builtinProductSkills` is off: a skill's name and description live in the
 * system prompt for the whole session, so dropping them has to happen while
 * the catalog is assembled — a later filter would leave them advertised to
 * the model. Only an explicit opt-out drops them, so a missing or
 * not-yet-registered section behaves like the shipped default.
 *
 * The load awaits config readiness before reading that switch: this is the
 * lowest-priority source, so the workspace catalog loads it first, and the
 * contribution it produces is kept for the life of the handler with no reload
 * path — reading too early would strand the startup configuration.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';

import { visibleBuiltinSkills } from './builtin/builtin';
import { builtinProductSkillsEnabled } from './configSection';
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

  constructor(@IConfigService private readonly config: IConfigService) {}

  async load(): Promise<SkillContribution> {
    await this.config.ready;
    return { skills: visibleBuiltinSkills(builtinProductSkillsEnabled(this.config)) };
  }
}

registerScopedService(
  LifecycleScope.App,
  IBuiltinSkillSource,
  BuiltinSkillSource,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
