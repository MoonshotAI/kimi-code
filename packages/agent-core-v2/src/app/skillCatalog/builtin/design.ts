/**
 * `skillCatalog` domain (L3) — builtin `design` skill bundle.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';

import DESIGN_BODY from './design/SKILL.md?raw';
import DESIGN_UX_DESIGNER_BODY from './design/ux-designer/SKILL.md?raw';
import DESIGN_VISUALIZATION_EXPERT_BODY from './design/visualization-expert/SKILL.md?raw';

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

export const DESIGN_SKILL = makeBuiltin(
  DESIGN_BODY,
  'design',
  'builtin://design',
  { 'has-sub-skill': true },
);

export const DESIGN_UX_DESIGNER_SKILL = makeBuiltin(
  DESIGN_UX_DESIGNER_BODY,
  'design.ux-designer',
  'builtin://design/ux-designer',
  { isSubSkill: true },
);

export const DESIGN_VISUALIZATION_EXPERT_SKILL = makeBuiltin(
  DESIGN_VISUALIZATION_EXPERT_BODY,
  'design.visualization-expert',
  'builtin://design/visualization-expert',
  { isSubSkill: true },
);

