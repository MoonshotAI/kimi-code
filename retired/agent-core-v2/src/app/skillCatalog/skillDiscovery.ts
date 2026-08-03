/**
 * `skillCatalog` domain (L3) — catalog discovery contract.
 *
 * `ISkillDiscovery` is the single generic filesystem primitive that hides how
 * skill bundles are discovered: a backend walks the caller-supplied skill
 * roots, reads each SKILL.md, and parses it into `SkillDefinition`s. Global vs
 * project discovery differ only by which roots are passed in — there is one
 * `discover(roots)`, not per-kind methods. The skill domain depends on this
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
  discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult>;
}

export const ISkillDiscovery = createDecorator<ISkillDiscovery>('skillDiscovery');
