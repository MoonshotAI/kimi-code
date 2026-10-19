import type { SkillDefinition } from '#/features/skill/catalog/types';
import { parseSkillText } from '#/features/skill/catalog/parser';
import UPDATE_CONFIG_BODY from './update-config.md?raw';

const PSEUDO_PATH = 'builtin://update-config';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/update-config.md',
  skillDirName: 'update-config',
  source: 'builtin',
  text: UPDATE_CONFIG_BODY,
});

export const UPDATE_CONFIG_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
  productSpecific: true,
};
