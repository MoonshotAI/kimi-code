import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import EMBEDDED_SYSTEMS_BODY from './embedded-systems/SKILL.md?raw';

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

export const EMBEDDED_SYSTEMS_SKILL = makeBuiltin(
  EMBEDDED_SYSTEMS_BODY,
  'embedded-systems',
  'builtin://embedded-systems',
  {},
);

