import { parseSkillText } from '../parser';
import type { SkillDefinition } from '../types';

import SECURITY_BODY from './security/SKILL.md?raw';
import SECURITY_FULLSTACK_GUARDIAN_BODY from './security/fullstack-guardian/SKILL.md?raw';
import SECURITY_SECURE_CODE_GUARDIAN_BODY from './security/secure-code-guardian/SKILL.md?raw';
import SECURITY_SECURITY_REVIEWER_BODY from './security/security-reviewer/SKILL.md?raw';

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

export const SECURITY_SKILL = makeBuiltin(
  SECURITY_BODY,
  'security',
  'builtin://security',
  { 'has-sub-skill': true },
);

export const SECURITY_FULLSTACK_GUARDIAN_SKILL = makeBuiltin(
  SECURITY_FULLSTACK_GUARDIAN_BODY,
  'security.fullstack-guardian',
  'builtin://security/fullstack-guardian',
  { isSubSkill: true },
);

export const SECURITY_SECURE_CODE_GUARDIAN_SKILL = makeBuiltin(
  SECURITY_SECURE_CODE_GUARDIAN_BODY,
  'security.secure-code-guardian',
  'builtin://security/secure-code-guardian',
  { isSubSkill: true },
);

export const SECURITY_SECURITY_REVIEWER_SKILL = makeBuiltin(
  SECURITY_SECURITY_REVIEWER_BODY,
  'security.security-reviewer',
  'builtin://security/security-reviewer',
  { isSubSkill: true },
);

