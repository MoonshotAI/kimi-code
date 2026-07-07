import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import WRITE_GOAL_BODY from './write-goal.md?raw';

const PSEUDO_PATH = 'builtin://write-goal';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/write-goal.md',
  skillDirName: 'write-goal',
  source: 'builtin',
  text: WRITE_GOAL_BODY,
});

export const WRITE_GOAL_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
