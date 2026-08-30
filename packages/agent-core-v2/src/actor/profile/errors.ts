import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import type { ErrorCode } from '#/errors';
import { Error2 } from '#/_base/errors/errors';

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

export type ProfileErrorCode = (typeof ProfileErrors.codes)[keyof typeof ProfileErrors.codes];

export class ProfileError extends Error2 {
  constructor(code: ProfileErrorCode, message: string, details?: Record<string, unknown>) {
    super(code as ErrorCode, message, { details });
    this.name = 'ProfileError';
  }
}
