import type { SkillRegistry } from '../registry';
import { MCP_CONFIG_SKILL } from './mcp-config';
import { UPDATE_CONFIG_SKILL } from './update-config';

export function registerBuiltinSkills(registry: SkillRegistry): void {
  registry.registerBuiltinSkill(MCP_CONFIG_SKILL);
  registry.registerBuiltinSkill(UPDATE_CONFIG_SKILL);
}

export { MCP_CONFIG_SKILL, UPDATE_CONFIG_SKILL };
