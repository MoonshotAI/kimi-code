import type { SkillDefinition } from '../../skill';

export interface SkillRegistry {
  getSkill(name: string): SkillDefinition | undefined;
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string;
  listInvocableSkills(): readonly SkillDefinition[];
  getSkillRoots(): readonly string[];
  getModelSkillListing(): string;
  /** True when the skill name is listed in config `disabled_skills`. */
  isSkillDisabled(name: string): boolean;
}
