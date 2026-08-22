/**
 * `skillCatalog` domain (L3) — builtin `legal-risk-assessment` skill definition.
 */

import type { SkillDefinition } from '#/app/skillCatalog/types';
import { parseSkillText } from '#/app/skillCatalog/parser';
import LEGAL_RISK_ASSESSMENT_BODY from './legal-risk-assessment.md?raw';

const PSEUDO_PATH = 'builtin://legal-risk-assessment';

const parsed = parseSkillText({
  skillMdPath: '/builtin/skills/legal-risk-assessment.md',
  skillDirName: 'legal-risk-assessment',
  source: 'builtin',
  text: LEGAL_RISK_ASSESSMENT_BODY,
});

export const LEGAL_RISK_ASSESSMENT_SKILL: SkillDefinition = {
  ...parsed,
  path: PSEUDO_PATH,
  dir: PSEUDO_PATH,
  metadata: {
    ...parsed.metadata,
    type: parsed.metadata.type ?? 'inline',
  },
};
