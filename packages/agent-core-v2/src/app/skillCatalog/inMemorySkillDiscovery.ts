import { LifecycleScope } from '#/app/scopes';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';

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
    return { skills, skipped: [], scannedRoots: [], scannedDirectories: [] };
  }
}

registerScopedService(
  LifecycleScope.App,
  ISkillDiscovery,
  InMemorySkillDiscovery,
  ScopeActivation.OnScopeCreated,
  'skillCatalog',
);
