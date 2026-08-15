/**
 * `tower` domain — the builtin `tower` skill definition (the `/tower` slash
 * command body). Self-registers into the builtin skill catalog at import via
 * `registerBuiltinSkill` (the static import=register channel), so no builtin
 * module needs to know the skill exists.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import { registerBuiltinSkill } from '#/app/skillCatalog/builtin/registry';
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

registerBuiltinSkill(TOWER_SKILL);
