import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import DESIGN_BODY from './design/SKILL.md?raw';
import DESIGN_UX_DESIGNER_BODY from './design/ux-designer/SKILL.md?raw';
import DESIGN_UX_DESIGNER_AGENTS from './design/ux-designer/AGENTS.md?raw';
import DESIGN_UX_DESIGNER_RULES_ACCESSIBILITY from './design/ux-designer/rules/accessibility.md?raw';
import DESIGN_UX_DESIGNER_RULES_INFORMATION_ARCHITECTURE from './design/ux-designer/rules/information-architecture.md?raw';
import DESIGN_UX_DESIGNER_RULES_INTERACTION_DESIGN from './design/ux-designer/rules/interaction-design.md?raw';
import DESIGN_UX_DESIGNER_RULES_RESEARCH from './design/ux-designer/rules/research.md?raw';
import DESIGN_UX_DESIGNER_RULES_VISUAL_DESIGN from './design/ux-designer/rules/visual-design.md?raw';
import DESIGN_VISUALIZATION_EXPERT_BODY from './design/visualization-expert/SKILL.md?raw';

function makeBuiltin(
  body: string,
  dirName: string,
  pseudoPath: string,
  extraMetadata: Record<string, unknown> = {},
  resources?: Readonly<Record<string, string>>,
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
    resources,
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
  {
    'AGENTS.md': DESIGN_UX_DESIGNER_AGENTS,
    'rules/accessibility.md': DESIGN_UX_DESIGNER_RULES_ACCESSIBILITY,
    'rules/information-architecture.md': DESIGN_UX_DESIGNER_RULES_INFORMATION_ARCHITECTURE,
    'rules/interaction-design.md': DESIGN_UX_DESIGNER_RULES_INTERACTION_DESIGN,
    'rules/research.md': DESIGN_UX_DESIGNER_RULES_RESEARCH,
    'rules/visual-design.md': DESIGN_UX_DESIGNER_RULES_VISUAL_DESIGN,
  },
);

export const DESIGN_VISUALIZATION_EXPERT_SKILL = makeBuiltin(
  DESIGN_VISUALIZATION_EXPERT_BODY,
  'design.visualization-expert',
  'builtin://design/visualization-expert',
  { isSubSkill: true },
);

