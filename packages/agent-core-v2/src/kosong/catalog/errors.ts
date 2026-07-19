/**
 * `kosong/catalog` domain (L3) — catalog error codes.
 *
 * The codes are intentionally identical to the deleted legacy
 * `app/modelCatalog` domain's (the wire contract branches on them). The
 * error registry keys on the contributing `codes` OBJECT, so the legacy
 * module could never be loaded together with this one — with it deleted in
 * Phase 5, this domain is the sole owner of the codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelCatalogErrors = {
  codes: {
    PROVIDER_NOT_FOUND: 'provider.not_found',
    MODEL_NOT_FOUND: 'model.not_found',
  },
  info: {
    'provider.not_found': {
      title: 'Provider not found',
      retryable: false,
      public: true,
      action: 'Check the provider id or configure the provider first.',
    },
    'model.not_found': {
      title: 'Model not found',
      retryable: false,
      public: true,
      action: 'Check the model alias or configure the model first.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ModelCatalogErrors);
