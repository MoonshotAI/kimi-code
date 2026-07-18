/**
 * `auth` domain error codes.
 */

import { t } from '@moonshot-ai/kimi-i18n';
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AuthErrors = {
  codes: {
    AUTH_LOGIN_REQUIRED: 'auth.login_required',
    AUTH_PROVISIONING_REQUIRED: 'auth.provisioning_required',
    AUTH_TOKEN_MISSING: 'auth.token_missing',
    AUTH_TOKEN_UNAUTHORIZED: 'auth.token_unauthorized',
    AUTH_MODEL_NOT_RESOLVED: 'auth.model_not_resolved',
  },
  info: {
    'auth.login_required': {
      title: t('v2Errors.authLoginRequired'),
      retryable: false,
      public: true,
      action: t('v2Errors.authLoginRequiredAction'),
    },
    'auth.provisioning_required': {
      title: t('v2Errors.authProvisioningRequired'),
      retryable: false,
      public: true,
      action: t('v2Errors.authProvisioningRequiredAction'),
    },
    'auth.token_missing': {
      title: t('v2Errors.authTokenMissing'),
      retryable: false,
      public: true,
      action: t('v2Errors.authTokenMissingAction'),
    },
    'auth.token_unauthorized': {
      title: t('v2Errors.authTokenUnauthorized'),
      retryable: false,
      public: true,
      action: t('v2Errors.authTokenUnauthorizedAction'),
    },
    'auth.model_not_resolved': {
      title: t('v2Errors.authModelNotResolved'),
      retryable: false,
      public: true,
      action: t('v2Errors.authModelNotResolvedAction'),
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AuthErrors);
