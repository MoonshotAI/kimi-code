/**
 * `profile` domain error codes — model/provider configuration failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ProfileErrors = {
  codes: {
    MODEL_NOT_CONFIGURED: 'model.not_configured',
    MODEL_CONFIG_INVALID: 'model.config_invalid',
    THINKING_ALIAS_CONFLICT: 'profile.thinking_alias_conflict',
    PROFILE_UNKNOWN: 'profile.unknown',
    PROFILE_ALREADY_BOUND: 'profile.already_bound',
    PROFILE_NOT_BOUND: 'profile.not_bound',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ProfileErrors);
