import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import MCP_CONFIG_BODY from './mcp-config.md?raw';

const PSEUDO_PATH = 'builtin://mcp-config';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/mcp-config.md',
  skillDirName: 'mcp-config',
  source: 'builtin',
  text: MCP_CONFIG_BODY,
});

export const MCP_CONFIG_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
