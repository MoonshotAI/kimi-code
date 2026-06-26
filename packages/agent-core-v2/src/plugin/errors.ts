/**
 * `plugin` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const PluginErrors = {
  codes: {
    PLUGIN_NOT_FOUND: 'plugin.not_found',
    PLUGIN_LOAD_FAILED: 'plugin.load_failed',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PluginErrors);
