/**
 * `globalSkillCatalog` domain (L5) — catalog discovery contract.
 *
 * `ISkillDiscovery` is a business-specific interface that hides how skill
 * bundles are discovered: a backend walks a skill root, reads each SKILL.md,
 * and parses it into `SkillDefinition`s. The skill domain depends on this
 * interface only and never touches `node:fs` / `hostFs`; the backend is chosen
 * at the composition root (file locally, in-memory for tests, object storage or
 * a DB on a server). App-scoped.
 */

import { createDecorator } from '#/_base/di/instantiation';

import type { SkillDefinition, SkillRoot, SkippedSkill } from './types';

export interface SkillDiscoveryResult {
  readonly skills: readonly SkillDefinition[];
  readonly skipped: readonly SkippedSkill[];
  readonly scannedRoots: readonly string[];
}

export interface ISkillDiscovery {
  readonly _serviceBrand: undefined;

  discoverProject(
    workDir: string,
    extraRoots?: readonly SkillRoot[],
  ): Promise<SkillDiscoveryResult>;
  discoverUser(homeDir: string, osHomeDir: string): Promise<SkillDiscoveryResult>;
}

export const ISkillDiscovery = createDecorator<ISkillDiscovery>('skillDiscovery');
