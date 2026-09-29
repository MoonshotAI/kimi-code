import {
  createCollection,
  lineage,
  pushCleanup,
  useNode,
  type UnitNode,
  type Unsubscribe,
} from '@moonshot-ai/agent-core/kernel/index';

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
  onDidChange?: (listener: () => void) => Unsubscribe;
}

export const SkillSources = createCollection<SkillCatalogSource>('skill.sources');

export function useSkillSource(source: SkillCatalogSource): void {
  const node = useNode();
  pushCleanup(
    node,
    ([...lineage(node)].at(-1) as UnitNode).contribute(SkillSources, source, 0),
  );
}
