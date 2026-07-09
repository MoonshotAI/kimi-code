/**
 * `skillCatalog` domain (L3) — in-memory `ISkillDiscovery` backend.
 *
 * Returns preset skill lists for discovery without any IO. Registered as the
 * App-scope default so tests and scopes work without a filesystem; the
 * production composition root overrides it with the filesystem backend. A call
 * seeded with project roots returns the project skills, one seeded with user
 * roots returns the user skills, one seeded with extra roots returns the extra
 * skills, one seeded with plugin roots returns the plugin skills, and an empty
 * root list (the common test case where the resolved directories do not exist on
 * disk) returns the user and project skills the double holds — user skills first,
 * project skills last, so project entries win the within-list collision resolution
 * the same way the workspace source's higher priority wins across sources.
 * App-scoped.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

import type { SkillDiscoveryResult } from './skillDiscovery';
import { ISkillDiscovery } from './skillDiscovery';
import type { SkillDefinition, SkillRoot } from './types';

export class InMemorySkillDiscovery implements ISkillDiscovery {
  declare readonly _serviceBrand: undefined;

  private projectSkills: readonly SkillDefinition[] = [];
  private userSkills: readonly SkillDefinition[] = [];
  private pluginSkills: readonly SkillDefinition[] = [];
  private extraSkills: readonly SkillDefinition[] = [];

  setProjectSkills(skills: readonly SkillDefinition[]): void {
    this.projectSkills = [...skills];
  }

  setUserSkills(skills: readonly SkillDefinition[]): void {
    this.userSkills = [...skills];
  }

  setPluginSkills(skills: readonly SkillDefinition[]): void {
    this.pluginSkills = [...skills];
  }

  setExtraSkills(skills: readonly SkillDefinition[]): void {
    this.extraSkills = [...skills];
  }

  async discover(roots: readonly SkillRoot[]): Promise<SkillDiscoveryResult> {
    const skills: SkillDefinition[] = [];
    if (roots.length === 0) {
      skills.push(...this.userSkills, ...this.projectSkills);
    } else {
      if (roots.some((root) => root.plugin !== undefined)) skills.push(...this.pluginSkills);
      if (roots.some((root) => root.source === 'extra')) skills.push(...this.extraSkills);
      if (roots.some((root) => root.source === 'user')) skills.push(...this.userSkills);
      if (roots.some((root) => root.source === 'project')) skills.push(...this.projectSkills);
    }
    return { skills, skipped: [], scannedRoots: [] };
  }
}

registerScopedService(
  LifecycleScope.App,
  ISkillDiscovery,
  InMemorySkillDiscovery,
  InstantiationType.Delayed,
  'skillCatalog',
);
