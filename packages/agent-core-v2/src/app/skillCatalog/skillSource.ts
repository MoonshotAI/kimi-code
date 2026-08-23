import type { Event } from '#/_base/event';

import type { SkillDefinition, SkippedSkill } from './types';

export interface SkillContribution {
  readonly skills: readonly SkillDefinition[];
  readonly skipped?: readonly SkippedSkill[];
  readonly scannedRoots?: readonly string[];
}

export const SKILL_SOURCE_PRIORITY = {
  builtin: 0,
  plugin: 5,
  extra: 10,
  user: 20,
  workspace: 30,
} as const;

export const PLUGIN_SKILL_SOURCE_ID = 'plugin';
export const BUILTIN_SKILL_SOURCE_ID = 'builtin';

export interface ISkillSource {
  readonly _serviceBrand: undefined;
  readonly id: string;
  readonly priority: number;
  readonly onDidChange?: Event<void>;
  load(): Promise<SkillContribution>;
}
