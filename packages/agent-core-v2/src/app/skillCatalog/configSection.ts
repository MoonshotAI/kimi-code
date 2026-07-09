/**
 * `skillCatalog` domain (L3) — skill config sections.
 *
 * Registers the v1-compatible top-level config domains `extraSkillDirs` and
 * `mergeAllAvailableSkills`. Values stay camelCase in memory; TOML uses the
 * snake_case keys `extra_skill_dirs` and `merge_all_available_skills`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const EXTRA_SKILL_DIRS_SECTION = 'extraSkillDirs';
export const ExtraSkillDirsConfigSchema = z.array(z.string()).optional();
export type ExtraSkillDirsConfig = z.infer<typeof ExtraSkillDirsConfigSchema>;

registerConfigSection(EXTRA_SKILL_DIRS_SECTION, ExtraSkillDirsConfigSchema, {
  defaultValue: [],
});

export const MERGE_ALL_AVAILABLE_SKILLS_SECTION = 'mergeAllAvailableSkills';
export const MergeAllAvailableSkillsConfigSchema = z.boolean().optional();
export type MergeAllAvailableSkillsConfig = z.infer<typeof MergeAllAvailableSkillsConfigSchema>;

registerConfigSection(MERGE_ALL_AVAILABLE_SKILLS_SECTION, MergeAllAvailableSkillsConfigSchema, {
  defaultValue: true,
});
