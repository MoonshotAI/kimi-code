import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import CUSTOM_THEME_BODY from './custom-theme.md?raw';

const PSEUDO_PATH = 'builtin://custom-theme';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/custom-theme.md',
  skillDirName: 'custom-theme',
  source: 'builtin',
  text: CUSTOM_THEME_BODY,
});

export const CUSTOM_THEME_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
