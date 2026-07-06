/**
 * `skillCatalog` domain (L3) — skill-source contract.
 *
 * `ISkillSource` is the producer half of the skill subsystem: each source loads
 * a `SkillContribution` and advertises a `priority` so the Session sink can
 * ordered-merge contributions (higher priority wins name collisions). Sources
 * PUSH into the sink; the sink is a dumb ordered-merge table. Concrete sources
 * (builtin/user at App scope, workspace/plugin at Session scope) each bind
 * their own DI token extending this contract.
 */

import type { Event } from '#/_base/event';

import type { SkillDefinition } from './types';

export interface SkillContribution {
  readonly skills: readonly SkillDefinition[];
}

export interface ISkillSource {
  readonly _serviceBrand: undefined;
  readonly id: string;
  readonly priority: number;
  readonly onDidChange?: Event<void>;
  load(): Promise<SkillContribution>;
}
