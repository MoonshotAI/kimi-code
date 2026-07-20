import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import TESTING_BODY from './testing/SKILL.md?raw';
import TESTING_CODE_REVIEWER_BODY from './testing/code-reviewer/SKILL.md?raw';
import TESTING_PLAYWRIGHT_EXPERT_BODY from './testing/playwright-expert/SKILL.md?raw';
import TESTING_TEST_MASTER_BODY from './testing/test-master/SKILL.md?raw';

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

export const TESTING_SKILL = makeBuiltin(
  TESTING_BODY,
  'testing',
  'builtin://testing',
  { 'has-sub-skill': true },
);

export const TESTING_CODE_REVIEWER_SKILL = makeBuiltin(
  TESTING_CODE_REVIEWER_BODY,
  'testing.code-reviewer',
  'builtin://testing/code-reviewer',
  { isSubSkill: true },
);

export const TESTING_PLAYWRIGHT_EXPERT_SKILL = makeBuiltin(
  TESTING_PLAYWRIGHT_EXPERT_BODY,
  'testing.playwright-expert',
  'builtin://testing/playwright-expert',
  { isSubSkill: true },
);

export const TESTING_TEST_MASTER_SKILL = makeBuiltin(
  TESTING_TEST_MASTER_BODY,
  'testing.test-master',
  'builtin://testing/test-master',
  { isSubSkill: true },
);

