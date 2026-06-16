import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import DEEP_RESEARCH_BODY from './deep-research.md?raw';

const PSEUDO_PATH = 'builtin://deep-research';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/deep-research.md',
  skillDirName: 'deep-research',
  source: 'builtin',
  text: DEEP_RESEARCH_BODY,
});

export const DEEP_RESEARCH_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
