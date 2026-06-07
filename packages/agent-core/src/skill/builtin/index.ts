import { flags } from '../../flags/resolver';
import type { SkillRegistry } from '../registry';
import { MCP_CONFIG_SKILL } from './mcp-config';
import {
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
} from './sub-skill';
import { UPDATE_CONFIG_SKILL } from './update-config';

type SubSkillFlagResolver = {
  enabled(id: 'sub_skill'): boolean;
};

export function registerBuiltinSkills(
  registry: SkillRegistry,
  options: { readonly experimentalFlags?: SubSkillFlagResolver } = {},
): void {
  const experimentalFlags = options.experimentalFlags ?? flags;
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
  registry.registerBuiltinSkill(UPDATE_CONFIG_SKILL);
  if (experimentalFlags.enabled('sub_skill')) {
    registry.registerBuiltinSkill(SUB_SKILL_PARENT);
    registry.registerBuiltinSkill(SUB_SKILL_REVIEW);
    registry.registerBuiltinSkill(SUB_SKILL_CONSOLIDATE);
  }
}

export {
  MCP_CONFIG_SKILL,
  SUB_SKILL_CONSOLIDATE,
  SUB_SKILL_PARENT,
  SUB_SKILL_REVIEW,
  UPDATE_CONFIG_SKILL,
};
