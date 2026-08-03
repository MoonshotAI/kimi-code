import type { SkillDefinition } from '../../skill';

export interface SkillRegistry {
  getSkill(name: string): SkillDefinition | undefined;
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string;
  listInvocableSkills(): readonly SkillDefinition[];
  getSkillRoots(): readonly string[];
  getModelSkillListing(): string;
}
