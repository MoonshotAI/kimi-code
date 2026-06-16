import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import DEBUG_BODY from './debug.md?raw';

const PSEUDO_PATH = 'builtin://debug';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/debug.md',
  skillDirName: 'debug',
  source: 'builtin',
  text: DEBUG_BODY,
});

export const DEBUG_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
