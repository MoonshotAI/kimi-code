/**
 * `kosong/model` domain (L2) — catalog error codes.
 *
 * The codes are intentionally identical to the deleted legacy
 * `app/modelCatalog` domain's (the wire contract branches on them). The
 * error registry keys on the contributing `codes` OBJECT, so the legacy
 * module could never be loaded together with this one — this domain is the
 * sole owner of the codes. `provider.not_found` is shared with the
 * `kosong/provider` discovery service.
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