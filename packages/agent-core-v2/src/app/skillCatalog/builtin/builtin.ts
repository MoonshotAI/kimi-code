/**
 * `skillCatalog` domain — builtin skill registration.
 *
 * Code-defined builtin skills are constants (not discovered from storage), so
 * they bypass `ISkillDiscovery`: `BUILTIN_SKILLS` plus the feature-authored
 * contributions registered through `registerBuiltinSkill` (./registry — the
 * "import = register" channel, e.g. the tower skill) feed the builtin
 * `ISkillSource`.
 *
 * `visibleBuiltinSkills` is the one place that decides which of them the
 * `builtin_product_skills` switch excludes. Every consumer goes through it — the
 * session-scoped source and the session-less workspace listings alike — so a
 * skill marked `productSpecific` cannot stay advertised on one surface while
 * being filtered on another.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';

import { CHECK_KIMI_CODE_DOCS_SKILL } from './check-kimi-code-docs';
import { CUSTOM_THEME_SKILL } from './custom-theme';
import { IMPORT_FROM_CC_CODEX_SKILL } from './import-from-cc-codex';
import { MCP_CONFIG_SKILL } from './mcp-config';
import { getBuiltinSkillContributions } from './registry';
import {
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
} from './sub-skill';
import { UPDATE_CONFIG_SKILL } from './update-config';
import { WRITE_GOAL_SKILL } from './write-goal';

export const BUILTIN_SKILLS: readonly SkillDefinition[] = [
  MCP_CONFIG_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  UPDATE_CONFIG_SKILL,
  CUSTOM_THEME_SKILL,
  WRITE_GOAL_SKILL,
  CHECK_KIMI_CODE_DOCS_SKILL,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  SUB_SKILL_CONSOLIDATE,
];

export function visibleBuiltinSkills(productSkillsEnabled: boolean): readonly SkillDefinition[] {
  const all = [...BUILTIN_SKILLS, ...getBuiltinSkillContributions()];
  if (productSkillsEnabled) return all;
  return all.filter((skill) => skill.productSpecific !== true);
}

export {
  CHECK_KIMI_CODE_DOCS_SKILL,
  CUSTOM_THEME_SKILL,
  IMPORT_FROM_CC_CODEX_SKILL,
  MCP_CONFIG_SKILL,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  UPDATE_CONFIG_SKILL,
  WRITE_GOAL_SKILL,
};
