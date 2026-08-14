/**
 * `tower` domain — the builtin `tower` skill definition (the `/tower` slash
 * command body). Registered into the builtin skill catalog from
 * `app/skillCatalog/builtin/builtin.ts`.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
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
    disableModelInvocation: true,
  },
};
