import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import ARCHITECT_BODY from './architect.md?raw';

const PSEUDO_PATH = 'builtin://architect';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/architect.md',
  skillDirName: 'architect',
  source: 'builtin',
  text: ARCHITECT_BODY,
});

export const ARCHITECT_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
