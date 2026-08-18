import { registerBuiltinSkill } from '#/app/skillCatalog/builtin/registry';
import { parseSkillText } from '#/app/skillCatalog/parser';
import type { SkillDefinition } from '#/app/skillCatalog/types';

import { FLOW_FLAG_ID } from '../flow';

import FLOW_BODY from './flow.md?raw';

const PSEUDO_PATH = 'builtin://flow';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/flow.md',
  skillDirName: 'flow',
  source: 'builtin',
  text: FLOW_BODY,
});

export const FLOW_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  experimentalFlag: FLOW_FLAG_ID,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};

registerBuiltinSkill(FLOW_SKILL);
