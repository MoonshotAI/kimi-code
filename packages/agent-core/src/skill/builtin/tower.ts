import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import TOWER_BODY from './tower.md?raw';

const PSEUDO_PATH = 'builtin://tower';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/tower.md',
  skillDirName: 'tower',
  source: 'builtin',
  text: TOWER_BODY,
});

export const TOWER_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
