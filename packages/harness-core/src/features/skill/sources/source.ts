import { createCollection, useCleanup } from '@moonshot-ai/agent-core/kernel/index';
import { currentUnit, lineage, type UnitNode } from '@moonshot-ai/agent-core/kernel/runtime';

import type { SkillDefinition, SkippedSkill } from '../catalog/types';

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

export interface SkillCatalogSource {
  readonly id: string;
  readonly priority: number;
  load(): Promise<SkillContribution>;
  onDidChange?: (listener: () => void) => () => void;
}

export const SkillSources = createCollection<SkillCatalogSource>('skill.sources');

export function useSkillSource(source: SkillCatalogSource): void {
  useCleanup(
    ([...lineage(currentUnit())].at(-1) as UnitNode).register(SkillSources, source, 0),
  );
}
