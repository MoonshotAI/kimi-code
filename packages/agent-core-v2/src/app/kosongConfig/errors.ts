/**
 * `kosongConfig` domain (L3) — models.dev import error codes.
 *
 * The edge (kap-server) branches on these codes to map them onto its numeric
 * protocol envelope, so the code strings are part of the wire contract.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ModelsDevImportErrors = {
  codes: {
    /** models.dev directory fetch failed and no built-in snapshot could fall back. */
    CATALOG_UNAVAILABLE: 'modelsDev.catalog_unavailable',
    /** The named entry does not exist in the models.dev directory. */
    CATALOG_ENTRY_NOT_FOUND: 'modelsDev.catalog_entry_not_found',
    /** A directory entry cannot be imported (rejected wire / missing or invalid base_url / no importable models / unusable id). */
    CATALOG_IMPORT_INVALID: 'modelsDev.import_invalid',
    /** A custom registry (api.json) cannot be imported (unreachable / invalid document / no valid entries). */
    REGISTRY_IMPORT_INVALID: 'modelsDev.registry_import_invalid',
    /** The target provider is managed by OAuth login and refuses REST writes. */
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
