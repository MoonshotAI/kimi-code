import KIMI_CODE_DOCS_BODY from './system/kimi-code-docs/SKILL.md?raw';
import { parseSkillText } from './parser';
import type { SessionSkillRegistry } from './registry';
import type { SkillDefinition } from './types';

const KIMI_CODE_DOCS_PSEUDO_PATH = 'system://kimi-code-docs';

const parsedKimiCodeDocsSkill = parseSkillText({
  skillMdPath: '/system/skills/kimi-code-docs/SKILL.md',
  skillDirName: 'kimi-code-docs',
  source: 'system',
  text: KIMI_CODE_DOCS_BODY,
});

export const KIMI_CODE_DOCS_SKILL: SkillDefinition = {
  ...parsedKimiCodeDocsSkill,
  path: KIMI_CODE_DOCS_PSEUDO_PATH,
  dir: KIMI_CODE_DOCS_PSEUDO_PATH,
};

export function registerSystemSkills(registry: SessionSkillRegistry): void {
  registry.register(KIMI_CODE_DOCS_SKILL);
}
