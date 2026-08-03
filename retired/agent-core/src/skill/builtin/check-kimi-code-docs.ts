import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import CHECK_KIMI_CODE_DOCS_BODY from './check-kimi-code-docs.md?raw';

const PSEUDO_PATH = 'builtin://check-kimi-code-docs';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/check-kimi-code-docs.md',
  skillDirName: 'check-kimi-code-docs',
  source: 'builtin',
  text: CHECK_KIMI_CODE_DOCS_BODY,
});

export const CHECK_KIMI_CODE_DOCS_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
