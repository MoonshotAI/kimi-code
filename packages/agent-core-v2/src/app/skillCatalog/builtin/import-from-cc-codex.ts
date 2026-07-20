/**
 * `skillCatalog` domain (L3) — builtin `import-from-cc-codex` skill definition.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import IMPORT_FROM_CC_CODEX_BODY from './import-from-cc-codex.md?raw';

const PSEUDO_PATH = 'builtin://import-from-cc-codex';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/import-from-cc-codex.md',
  skillDirName: 'import-from-cc-codex',
  source: 'builtin',
  text: IMPORT_FROM_CC_CODEX_BODY,
});

export const IMPORT_FROM_CC_CODEX_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
    disableModelInvocation: true,
  },
};
