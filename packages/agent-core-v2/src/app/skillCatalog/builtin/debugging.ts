/**
 * `skillCatalog` domain (L3) — builtin `debugging` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import DEBUGGING_BODY from './debugging/SKILL.md?raw';
import DEBUGGING_DEBUGGER_BODY from './debugging/debugger/SKILL.md?raw';
import DEBUGGING_DEBUGGING_WIZARD_BODY from './debugging/debugging-wizard/SKILL.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
): SkillDefinition {
  const parsed = parseSkillText({
    skillMdPath: `/builtin/skills/${dirName}/SKILL.md`,
    skillDirName: dirName,
    source: 'builtin',
    text: body,
  });
  return {
    ...parsed,
    name: dirName,
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
  };
}

export const DEBUGGING_SKILL = makeBuiltin(
  DEBUGGING_BODY,
  'debugging',
  'builtin://debugging',
  { 'has-sub-skill': true },
);

export const DEBUGGING_DEBUGGER_SKILL = makeBuiltin(
  DEBUGGING_DEBUGGER_BODY,
  'debugging.debugger',
  'builtin://debugging/debugger',
  { isSubSkill: true },
);

export const DEBUGGING_DEBUGGING_WIZARD_SKILL = makeBuiltin(
  DEBUGGING_DEBUGGING_WIZARD_BODY,
  'debugging.debugging-wizard',
  'builtin://debugging/debugging-wizard',
  { isSubSkill: true },
);

