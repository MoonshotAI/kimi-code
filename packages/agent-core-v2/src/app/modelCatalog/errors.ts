/**
 * `modelCatalog` domain error codes — provider/model catalog lookup failures.
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
