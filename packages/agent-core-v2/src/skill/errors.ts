/**
 * `skill` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const SkillErrors = {
  codes: {
    SKILL_NOT_FOUND: 'skill.not_found',
    SKILL_TYPE_UNSUPPORTED: 'skill.type_unsupported',
    SKILL_NAME_EMPTY: 'skill.name_empty',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(SkillErrors);
