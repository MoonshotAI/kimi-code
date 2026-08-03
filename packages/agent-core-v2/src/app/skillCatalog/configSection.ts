/**
 * `skillCatalog` domain — skill config sections.
 *
 * Registers the v1-compatible top-level config domains `extraSkillDirs` and
 * `mergeAllAvailableSkills`, plus `builtinProductSkills`. Values stay camelCase
 * in memory; TOML uses the snake_case keys `extra_skill_dirs`,
 * `merge_all_available_skills`, and `builtin_product_skills`.
 */

import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
import {
  type ConfigStripEnv,
  type EnvBindings,
  envBindings,
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

/**
 * Whether the builtin skills documenting this CLI itself — its `config.toml` /
 * `tui.toml` settings, custom themes, MCP setup, the official docs lookup, and
 * the Claude Code / Codex import — are offered to the model.
 *
 * On by default. Turning it off trims their names and descriptions from the
 * system prompt, where they otherwise sit on every turn; the trade is that the
 * model loses the guided flows for those tasks. Useful for unattended runs, or
 * for deployments where nobody is going to reconfigure the CLI mid-task.
 *
 * The whole section is one scalar, so the env binding covers it directly, and
 * `stripBuiltinProductSkillsEnv` keeps an env override from being written back
 * into `config.toml`.
 */
export const BUILTIN_PRODUCT_SKILLS_SECTION = 'builtinProductSkills';
export const BuiltinProductSkillsConfigSchema = z.boolean().optional();
export type BuiltinProductSkillsConfig = z.infer<typeof BuiltinProductSkillsConfigSchema>;

export const BUILTIN_PRODUCT_SKILLS_ENV = 'KIMI_CODE_BUILTIN_PRODUCT_SKILLS';

export const builtinProductSkillsEnvBindings: EnvBindings<BuiltinProductSkillsConfig> =
  envBindings(BuiltinProductSkillsConfigSchema, {
    env: BUILTIN_PRODUCT_SKILLS_ENV,
    parse: parseBooleanEnv,
  });

/**
 * Scalar-section counterpart to `stripEnvBoundFields`, which only walks object
 * fields: while the env var resolves, writes restore the env-free file value
 * instead of persisting the echoed override.
 */
export const stripBuiltinProductSkillsEnv: ConfigStripEnv<BuiltinProductSkillsConfig> = (
  value,
  raw,
  getEnv,
) => {
  if (getEnv === undefined) return value;
  if (parseBooleanEnv(getEnv(BUILTIN_PRODUCT_SKILLS_ENV)) === undefined) return value;
  // `raw` is the unvalidated file value; anything but a boolean means the file
  // held nothing usable, so the field is dropped rather than written back.
  return typeof raw === 'boolean' ? raw : undefined;
};

registerConfigSection(BUILTIN_PRODUCT_SKILLS_SECTION, BuiltinProductSkillsConfigSchema, {
  defaultValue: true,
  env: builtinProductSkillsEnvBindings,
  stripEnv: stripBuiltinProductSkillsEnv,
});
