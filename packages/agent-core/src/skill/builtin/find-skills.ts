import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import FIND_SKILLS_BODY from './find-skills/SKILL.md?raw';

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

export const FIND_SKILLS_SKILL = makeBuiltin(
  FIND_SKILLS_BODY,
  'find-skills',
  'builtin://find-skills',
  {},
);

