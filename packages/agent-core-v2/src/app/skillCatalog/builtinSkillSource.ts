/**
 * `skillCatalog` domain — builtin `ISkillSource` producer.
 *
 * Yields the code-defined `BUILTIN_SKILLS` as the lowest-priority contribution
 * (`builtin`, priority 0) so extra / user / workspace / plugin skills override
 * it on name collision. Bound at App scope.
 *
 * Product-documentation skills are filtered here rather than downstream: their
 * names sit in the system prompt for the whole session, and being the
 * lowest-priority source this one loads first and is kept for the life of the
 * handler — hence the wait for config readiness, and the change event that
 * lets the catalog reload it when the switch is toggled.
 */

import { Emitter, type Event } from '#/_base/event';
import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';

import { visibleBuiltinSkills } from './builtin/builtin';
import {
  BUILTIN_PRODUCT_SKILLS_SECTION,
  builtinProductSkillsEnabled,
} from './configSection';
import {
  BUILTIN_SKILL_SOURCE_ID,
  SKILL_SOURCE_PRIORITY,
  type ISkillSource,
  type SkillContribution,
} from './skillSource';

export interface IBuiltinSkillSource extends ISkillSource {
  readonly _serviceBrand: undefined;
}

export const IBuiltinSkillSource: ServiceIdentifier<IBuiltinSkillSource> =
  createDecorator<IBuiltinSkillSource>('builtinSkillSource');

export class BuiltinSkillSource extends Disposable implements IBuiltinSkillSource {
  declare readonly _serviceBrand: undefined;

  readonly id = BUILTIN_SKILL_SOURCE_ID;
  readonly priority = SKILL_SOURCE_PRIORITY.builtin;
  private readonly onDidChangeEmitter = this._register(new Emitter<void>());
  readonly onDidChange: Event<void> = this.onDidChangeEmitter.event;

  constructor(@IConfigService private readonly config: IConfigService) {
    super();
    this._register(
      this.config.onDidSectionChange((event) => {
        if (event.domain === BUILTIN_PRODUCT_SKILLS_SECTION) this.onDidChangeEmitter.fire();
      }),
    );
  }

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
