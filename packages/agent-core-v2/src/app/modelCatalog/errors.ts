/**
 * `modelCatalog` domain error codes — provider/model catalog lookup failures.
 */

import { t } from '@moonshot-ai/kimi-i18n';
import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelCatalogErrors = {
  codes: {
    PROVIDER_NOT_FOUND: 'provider.not_found',
    MODEL_NOT_FOUND: 'model.not_found',
  },
  info: {
    'provider.not_found': {
      title: t('v2Errors.providerNotFound'),
      retryable: false,
      public: true,
      action: t('v2Errors.providerNotFoundAction'),
    },
    'model.not_found': {
      title: t('v2Errors.modelNotFound'),
      retryable: false,
      public: true,
      action: t('v2Errors.modelNotFoundAction'),
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ModelCatalogErrors);
