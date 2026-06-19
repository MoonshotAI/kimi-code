import type { SkillDefinition } from '../../skill';
import type { SkillSearchResult } from '../../skill/search';

export interface SkillRegistry {
  getSkill(name: string): SkillDefinition | undefined;
  getPluginSkill(pluginId: string, name: string): SkillDefinition | undefined;
  renderSkillPrompt(skill: SkillDefinition, rawArgs: string): string;
  listInvocableSkills(): readonly SkillDefinition[];
  getSkillRoots(): readonly string[];
  getModelSkillListing(): string;
  searchSkills(query: string, limit?: number): readonly SkillSearchResult[];
}
