/**
 * `skillCatalog` domain (L3) — builtin skill registration.
 *
 * Code-defined builtin skills are constants (not discovered from storage), so
 * they bypass `ISkillDiscovery`: `BUILTIN_SKILLS` feeds the builtin
 * `ISkillSource`, and `registerBuiltinSkills` stamps them into an in-memory
 * catalog for edge composition without a Session.
 */

import type { InMemorySkillCatalog } from '#/app/skillCatalog/registry';
import type { SkillDefinition } from '#/app/skillCatalog/types';
import { CHECK_KIMI_CODE_DOCS_SKILL } from './check-kimi-code-docs';
import { CUSTOM_THEME_SKILL } from './custom-theme';
import { IMPORT_FROM_CC_CODEX_SKILL } from './import-from-cc-codex';
import { MCP_CONFIG_SKILL } from './mcp-config';
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

export function registerBuiltinSkills(registry: InMemorySkillCatalog): void {
  for (const skill of BUILTIN_SKILLS) {
    registry.registerBuiltinSkill(skill);
  }
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
