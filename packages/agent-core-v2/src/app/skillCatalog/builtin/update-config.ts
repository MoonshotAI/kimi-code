/**
 * `skillCatalog` domain (L3) — builtin `update-config` skill definition.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
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
};
