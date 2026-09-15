import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelsDevImportErrors = {
  codes: {
    CATALOG_UNAVAILABLE: 'modelsDev.catalog_unavailable',
    CATALOG_ENTRY_NOT_FOUND: 'modelsDev.catalog_entry_not_found',
    CATALOG_IMPORT_INVALID: 'modelsDev.import_invalid',
    REGISTRY_IMPORT_INVALID: 'modelsDev.registry_import_invalid',
    PROVIDER_OAUTH_MANAGED: 'provider.oauth_managed',
  },
  info: {
    'modelsDev.catalog_unavailable': {
      title: 'models.dev directory unavailable',
      retryable: true,
      public: true,
      action: 'Check the network connection to models.dev and try again.',
    },
    'modelsDev.catalog_entry_not_found': {
      title: 'Directory entry not found',
      retryable: false,
      public: true,
      action: 'Check the catalog id against the models.dev directory listing.',
    },
    'modelsDev.import_invalid': {
      title: 'Directory entry not importable',
      retryable: false,
      public: true,
      action: 'Pick another entry or supply the required base_url.',
    },
    'modelsDev.registry_import_invalid': {
      title: 'Custom registry not importable',
      retryable: false,
      public: true,
      action: 'Check the registry URL and credentials.',
    },
    'provider.oauth_managed': {
      title: 'Provider managed by OAuth login',
      retryable: false,
      public: true,
      action: 'Log out via the OAuth flow instead of editing the provider.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ModelsDevImportErrors);
