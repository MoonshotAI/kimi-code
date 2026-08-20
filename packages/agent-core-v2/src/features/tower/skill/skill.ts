import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import { registerBuiltinSkill } from '#/app/skillCatalog/builtin/registry';

import { TOWER_FLAG_ID } from '../tower';

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
  experimentalFlag: TOWER_FLAG_ID,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};

registerBuiltinSkill(TOWER_SKILL);
