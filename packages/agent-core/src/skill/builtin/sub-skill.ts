import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';
import CONSOLIDATE_BODY from './sub-skill/consolidate/SKILL.md';
import REVIEW_BODY from './sub-skill/review/SKILL.md';
import PARENT_BODY from './sub-skill/SKILL.md';

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
    path: pseudoPath,
    dir: pseudoPath,
    metadata: {
      ...parsed.metadata,
      type: parsed.metadata.type ?? 'inline',
      ...extraMetadata,
    },
  };
}

export const SUB_SKILL_PARENT = makeBuiltin(
  PARENT_BODY,
  'sub-skill',
  'builtin://sub-skill',
  { disableModelInvocation: true, 'has-sub-skill': true },
);

export const SUB_SKILL_REVIEW = makeBuiltin(
  REVIEW_BODY,
  'sub-skill.review',
  'builtin://sub-skill/review',
  { disableModelInvocation: true },
);

export const SUB_SKILL_CONSOLIDATE = makeBuiltin(
  CONSOLIDATE_BODY,
  'sub-skill.consolidate',
  'builtin://sub-skill/consolidate',
  { disableModelInvocation: true },
);
