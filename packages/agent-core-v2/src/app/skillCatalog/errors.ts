/**
 * `skillCatalog` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SkillErrors = {
  codes: {
    SKILL_NOT_FOUND: 'skill.not_found',
    SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
    SKILL_NAME_EMPTY: 'skill.name_empty',
    SKILL_PARSE_FAILED: 'skill.parse_failed',
    SKILL_NESTED_TOO_DEEP: 'skill.nested_too_deep',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(SkillErrors);
