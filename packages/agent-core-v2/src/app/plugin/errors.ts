import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const PluginErrors = {
  codes: {
    PLUGIN_NOT_FOUND: 'plugin.not_found',
    PLUGIN_LOAD_FAILED: 'plugin.load_failed',
    PLUGIN_CATALOG_CHANGED: 'plugin.catalog_changed',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PluginErrors);
