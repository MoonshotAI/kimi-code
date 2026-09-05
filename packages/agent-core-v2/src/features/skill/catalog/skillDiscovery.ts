import { createDecorator } from '#/_base/di/instantiation';

import type { SkillDefinition, SkillRoot, SkippedSkill } from './types';

export interface SkillDiscoveryResult {
  readonly skills: readonly SkillDefinition[];
  readonly skipped: readonly SkippedSkill[];
  readonly scannedRoots: readonly string[];
  readonly scannedDirectories: readonly string[];
}

export interface ISkillDiscovery {
  readonly _serviceBrand: undefined;
  discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult>;
}

export const ISkillDiscovery = createDecorator<ISkillDiscovery>('skillDiscovery');
