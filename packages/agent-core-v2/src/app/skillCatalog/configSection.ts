/**
 * `skillCatalog` domain — skill config sections.
 *
 * Registers the v1-compatible top-level config domains `extraSkillDirs` and
 * `mergeAllAvailableSkills`, plus `builtinProductSkills`. Values stay camelCase
 * in memory; TOML uses the snake_case keys `extra_skill_dirs`,
 * `merge_all_available_skills`, and `builtin_product_skills`.
 *
 * `builtinProductSkills` decides whether the builtin skills documenting this
 * CLI itself — its `config.toml` / `tui.toml` settings, custom themes, MCP
 * setup, the official docs lookup, and the Claude Code / Codex import — are
 * offered to the model. On by default; turning it off trims their names and
 * descriptions from the system prompt, where they otherwise sit on every turn,
 * at the cost of the guided flows for those tasks. Useful for unattended runs,
 * or deployments where nobody reconfigures the CLI mid-task.
 *
 * That section is a whole-section scalar rather than an object of fields, so
 * the env binding covers it directly and it needs its own strip:
 * `stripEnvBoundFields` only walks object fields, so an env override would
 * otherwise be written back into `config.toml`. The strip restores the
 * env-free file value while the env var resolves, and drops the field when the
 * file held anything but a boolean. `builtinProductSkillsEnabled` reads the
 * resolved switch; only an explicit opt-out disables, so a missing or
 * not-yet-registered section behaves like the shipped default.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
  type IConfigService,
} from '#/app/config/config';
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

export const BUILTIN_PRODUCT_SKILLS_SECTION = 'builtinProductSkills';
export const BuiltinProductSkillsConfigSchema = z.boolean().optional();
export type BuiltinProductSkillsConfig = z.infer<typeof BuiltinProductSkillsConfigSchema>;

export const BUILTIN_PRODUCT_SKILLS_ENV = 'KIMI_CODE_BUILTIN_PRODUCT_SKILLS';

export const builtinProductSkillsEnvBindings: EnvBindings<BuiltinProductSkillsConfig> =
  envBindings(BuiltinProductSkillsConfigSchema, {
    env: BUILTIN_PRODUCT_SKILLS_ENV,
    parse: parseBooleanEnv,
  });

export const stripBuiltinProductSkillsEnv: ConfigStripEnv<BuiltinProductSkillsConfig> = (
  value,
  raw,
  getEnv,
) => {
  if (getEnv === undefined) return value;
  if (parseBooleanEnv(getEnv(BUILTIN_PRODUCT_SKILLS_ENV)) === undefined) return value;
  return typeof raw === 'boolean' ? raw : undefined;
};

registerConfigSection(BUILTIN_PRODUCT_SKILLS_SECTION, BuiltinProductSkillsConfigSchema, {
  defaultValue: true,
  env: builtinProductSkillsEnvBindings,
  stripEnv: stripBuiltinProductSkillsEnv,
});

export function builtinProductSkillsEnabled(config: IConfigService): boolean {
  return config.get<BuiltinProductSkillsConfig>(BUILTIN_PRODUCT_SKILLS_SECTION) !== false;
}
