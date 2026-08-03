/**
 * `skillCatalog` domain — skill config sections.
 *
 * Registers skill configuration sections. Values stay camelCase in memory;
 * TOML uses snake_case keys.
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

export const SKILL_SOURCES_SECTION = 'skillSources';
export const SkillSourcesConfigSchema = z
  .object({
    workspace: z.boolean().optional(),
    user: z.boolean().optional(),
    explicit: z.boolean().optional(),
    extra: z.boolean().optional(),
    plugin: z.boolean().optional(),
    builtin: z.boolean().optional(),
  })
  .optional();
export type SkillSourcesConfig = z.infer<typeof SkillSourcesConfigSchema>;

registerConfigSection(SKILL_SOURCES_SECTION, SkillSourcesConfigSchema, {
  defaultValue: {},
});

export const EXCLUDE_SKILL_NAMES_SECTION = 'excludeSkillNames';
export const ExcludeSkillNamesConfigSchema = z.array(z.string()).optional();
export type ExcludeSkillNamesConfig = z.infer<typeof ExcludeSkillNamesConfigSchema>;

registerConfigSection(EXCLUDE_SKILL_NAMES_SECTION, ExcludeSkillNamesConfigSchema, {
  defaultValue: [],
});
